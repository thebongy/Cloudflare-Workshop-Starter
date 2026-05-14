import { AIChatAgent } from "@cloudflare/ai-chat"
import { getAgentByName } from "agents"
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai"
import { createWorkersAI } from "workers-ai-provider"

type ToolCall = {
  name: string
  input: unknown
  output?: unknown
  error?: string
}

type Message = {
  role: "user" | "assistant"
  text: string
  createdAt: string
  artifacts?: Array<{ kind: "tools"; title: string; calls: ToolCall[] }>
}

type McpConnection = {
  status: string
  serverId: string | null
  authUrl: string | null
  toolCount: number
  error?: string
}

type State = {
  messages: Message[]
  selectedRepo: string
  mcpConnection: McpConnection
  lastRun: { mcpCalls: ToolCall[]; result: string } | null
}

interface Env extends Cloudflare.Env {
  AI: Ai
  GitHubAgent: DurableObjectNamespace<GitHubAgent>
  ASSETS: Fetcher
  GITHUB_MCP_PAT?: string
}

const model = "@cf/moonshotai/kimi-k2.5"
const githubMcpUrl = "https://api.githubcopilot.com/mcp/"

export class GitHubAgent extends AIChatAgent<Env, State> {
  initialState: State = {
    messages: [],
    selectedRepo: "cloudflare/workers-sdk",
    mcpConnection: disconnected(),
    lastRun: null,
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/callback") return this.handleMcpCallback(request)
    if (url.pathname === "/state") return Response.json(this.snapshot(await this.refreshMcp()))

    if (url.pathname === "/chat" && request.method === "POST") {
      const { prompt, repo = this.state.selectedRepo } = await request.json<{ prompt?: string; repo?: string }>()
      if (!prompt) return Response.json({ error: "Missing prompt" }, { status: 400 })

      const run = await this.runDirectMcp(prompt, repo)
      const messages = [
        ...this.state.messages,
        message("user", prompt),
        message("assistant", run.result, [{ kind: "tools", title: "GitHub MCP calls", calls: run.mcpCalls }]),
      ].slice(-20)
      const state = { ...this.state, selectedRepo: repo, messages, lastRun: run, mcpConnection: this.connection() }
      this.setState(state)
      return Response.json(this.snapshot(state))
    }

    if (url.pathname === "/mcp/connect" && request.method === "POST") {
      const connection = await this.connectGitHubMcp(request)
      const state = { ...this.state, mcpConnection: connection }
      this.setState(state)
      return Response.json(this.snapshot(state))
    }

    if (url.pathname === "/mcp/status") return Response.json(this.snapshot(await this.refreshMcp()))

    if (url.pathname === "/mcp/disconnect" && request.method === "POST") {
      const connection = await this.disconnectGitHubMcp()
      const state = { ...this.state, mcpConnection: connection }
      this.setState(state)
      return Response.json(this.snapshot(state))
    }

    return Response.json({ error: "Not found" }, { status: 404 })
  }

  private async runDirectMcp(prompt: string, repo: string) {
    const mcpCalls: ToolCall[] = []
    const tools = await this.githubTools(mcpCalls)

    if (Object.keys(tools).length === 0) {
      return { mcpCalls, result: "GitHub MCP is not connected yet. Set GITHUB_MCP_PAT, restart Wrangler, and connect again." }
    }

    const workersai = createWorkersAI({ binding: this.env.AI })
    const result = await generateText({
      model: workersai(model),
      tools,
      stopWhen: stepCountIs(8),
      system: "You are a read-only GitHub maintainer assistant. Use GitHub MCP tools before answering.",
      messages: conversation(this.state.messages, repo, prompt),
    })

    return {
      mcpCalls,
      result: result.text.trim() || "The model finished without a text response. Inspect the tool calls above.",
    }
  }

  private async githubTools(calls: ToolCall[]): Promise<ToolSet> {
    await this.mcp.waitForConnections({ timeout: 3_000 }).catch(() => undefined)
    return traceTools(readonlyTools(this.mcp.getAITools({ serverName: "github" })), calls)
  }

  private async connectGitHubMcp(request: Request): Promise<McpConnection> {
    if (!this.env.GITHUB_MCP_PAT) return { ...disconnected(), status: "missing_token", error: "Set GITHUB_MCP_PAT before connecting." }

    const result = await this.addMcpServer("github", githubMcpUrl, {
      callbackHost: new URL(request.url).origin,
      callbackPath: "/api/agent/demo/callback",
      transport: { type: "streamable-http", headers: githubHeaders(this.env.GITHUB_MCP_PAT) },
    })
    await this.mcp.waitForConnections({ timeout: 4_000 }).catch(() => undefined)
    return this.connection(result.id, result.state, "authUrl" in result ? result.authUrl : null)
  }

  private async disconnectGitHubMcp(): Promise<McpConnection> {
    const connection = this.connection()
    if (connection.serverId) await this.removeMcpServer(connection.serverId)
    return disconnected()
  }

  private async refreshMcp(): Promise<State> {
    await this.mcp.waitForConnections({ timeout: 1_000 }).catch(() => undefined)
    const state = { ...this.state, mcpConnection: this.connection() }
    this.setState(state)
    return state
  }

  private connection(serverId?: string, defaultStatus = "disconnected", defaultAuthUrl: string | null = null): McpConnection {
    const mcp = this.getMcpServers()
    const entry = Object.entries(mcp.servers).find(([id, server]) => id === serverId || server.name === "github")
    const id = entry?.[0] ?? serverId ?? null
    const server = entry?.[1]
    return {
      status: String(server?.state ?? defaultStatus),
      serverId: id,
      authUrl: server?.auth_url ?? defaultAuthUrl,
      toolCount: Object.keys(readonlyTools(this.mcp.getAITools({ serverName: "github" }))).length,
      error: server?.error ?? undefined,
    }
  }

  private async handleMcpCallback(request: Request): Promise<Response> {
    const result = await this.mcp.handleCallbackRequest(request)
    if (result.authSuccess) await this.mcp.establishConnection(result.serverId)
    return Response.redirect(new URL("/", request.url).href)
  }

  private snapshot(state = this.state) {
    return {
      stage: "stage-03-direct-mcp",
      stageLabel: "Direct MCP baseline",
      model,
      state,
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/api/agent/")) return forwardToAgent(request, env)
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

async function forwardToAgent(request: Request, env: Env) {
  const url = new URL(request.url)
  const [, , , name = "demo", ...rest] = url.pathname.split("/")
  const path = rest.length ? `/${rest.join("/")}` : "/state"
  const target = new URL(path, url.origin)
  target.search = url.search
  const stub = await getAgentByName<Env, GitHubAgent>(env.GitHubAgent, name)
  return stub.fetch(new Request(target, request))
}

function traceTools(tools: ToolSet, calls: ToolCall[]): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = (tool as { execute?: (input: unknown, options: unknown) => Promise<unknown> }).execute
      if (!execute) return [name, tool]

      return [
        name,
        {
          ...tool,
          execute: async (input: unknown, options: unknown) => {
            const call: ToolCall = { name, input: compact(input) }
            calls.push(call)
            try {
              const output = await execute(input, options)
              call.output = compact(output)
              return output
            } catch (error) {
              call.error = error instanceof Error ? error.message : String(error)
              throw error
            }
          },
        },
      ]
    }),
  ) as ToolSet
}

function readonlyTools(tools: ToolSet): ToolSet {
  const blocked = /(^|_)(add|assign|close|create|delete|edit|merge|patch|post|put|remove|reopen|request|rerun|set|submit|update|write)(_|$)/
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !blocked.test(name.toLowerCase().replaceAll("-", "_")))) as ToolSet
}

function conversation(history: Message[], repo: string, prompt: string): ModelMessage[] {
  return [
    ...history.slice(-6).map((entry) => ({ role: entry.role, content: entry.text })),
    { role: "user", content: `Repository: ${repo}\nRequest: ${prompt}` },
  ] as ModelMessage[]
}

function disconnected(): McpConnection {
  return { status: "disconnected", serverId: null, authUrl: null, toolCount: 0 }
}

function githubHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "X-MCP-Readonly": "true" }
}

function message(role: Message["role"], text: string, artifacts: Message["artifacts"] = []): Message {
  return { role, text, artifacts, createdAt: new Date().toISOString() }
}

function compact(value: unknown): unknown {
  try {
    const json = JSON.stringify(value)
    if (!json) return value
    return json.length > 3_000 ? `${json.slice(0, 3_000)}...` : JSON.parse(json)
  } catch {
    return String(value)
  }
}
