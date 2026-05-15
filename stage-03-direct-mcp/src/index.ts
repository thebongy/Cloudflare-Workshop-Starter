import { createOpenAI } from "@ai-sdk/openai"
import { AIChatAgent } from "@cloudflare/ai-chat"
import { getAgentByName } from "agents"
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai"
import { createWorkersAI } from "workers-ai-provider"

type ToolCall = {
  name: string
  input: unknown
  output?: unknown
  error?: string
}

type Artifact = { kind: "tools"; title: string; calls: ToolCall[] }

type Message = {
  role: "user" | "assistant"
  text: string
  createdAt: string
  artifacts?: Artifact[]
  transient?: boolean
}

type StreamEvent = { type: "message"; message: Message } | { type: "snapshot"; snapshot: unknown }
type StreamSend = (event: StreamEvent) => void

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
  OPENAI_API_KEY?: string
}

const workersAiModel = "@cf/moonshotai/kimi-k2.6"
const openaiModel = "gpt-5.5"
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

    if (url.pathname === "/clear" && request.method === "POST") {
      const state = { ...this.state, messages: [], lastRun: null, mcpConnection: this.connection() }
      this.setState(state)
      return Response.json(this.snapshot(state))
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      const { prompt, repo = this.state.selectedRepo } = await request.json<{ prompt?: string; repo?: string }>()
      if (!prompt) return Response.json({ error: "Missing prompt" }, { status: 400 })

      return this.streamDirectMcpChat(prompt, repo)
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

  private streamDirectMcpChat(prompt: string, repo: string): Response {
    const encoder = new TextEncoder()

    return new Response(
      new ReadableStream({
        start: async (controller) => {
          const liveMessages: Message[] = []
          const send: StreamSend = (event) => {
            if (event.type === "message") {
              const liveMessage = { ...event.message, transient: true }
              liveMessages.push(liveMessage)
              controller.enqueue(encoder.encode(`${JSON.stringify({ ...event, message: liveMessage })}\n`))
              return
            }
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
          }

          try {
            send({ type: "message", message: message("assistant", "Starting the direct MCP agent loop.") })
            const run = await this.runDirectMcp(prompt, repo, send)
            const messages = [
              ...this.state.messages,
              message("user", prompt),
              ...liveMessages,
              message("assistant", run.result, [{ kind: "tools", title: "GitHub MCP calls", calls: run.mcpCalls }]),
            ].slice(-40)
            const state = { ...this.state, selectedRepo: repo, messages, lastRun: run, mcpConnection: this.connection() }
            this.setState(state)
            send({ type: "snapshot", snapshot: this.snapshot(state) })
          } catch (error) {
            const run = { mcpCalls: [], result: error instanceof Error ? error.message : String(error) }
            const messages = [...this.state.messages, message("user", prompt), ...liveMessages, message("assistant", run.result)].slice(-40)
            const state = { ...this.state, selectedRepo: repo, messages, lastRun: run, mcpConnection: this.connection() }
            this.setState(state)
            send({ type: "snapshot", snapshot: this.snapshot(state) })
          } finally {
            controller.close()
          }
        },
      }),
      { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" } },
    )
  }

  private async runDirectMcp(prompt: string, repo: string, send?: StreamSend) {
    const mcpCalls: ToolCall[] = []
    const tools = await this.githubTools(mcpCalls, send)

    if (Object.keys(tools).length === 0) {
      return { mcpCalls, result: "GitHub MCP is not connected yet. Set GITHUB_MCP_PAT, restart Wrangler, and connect again." }
    }

    const result = await generateText({
      model: languageModel(this.env),
      tools,
      stopWhen: stepCountIs(10),
      prepareStep: ({ stepNumber }) => {
        send?.({ type: "message", message: message("assistant", `Agent turn ${stepNumber + 1}: choosing a GitHub MCP tool or final answer.`) })
        return stepNumber === 0 ? { toolChoice: "required" } : {}
      },
      system:
        "You are a read-only GitHub maintainer assistant. Use GitHub MCP tools before answering. After every tool result, either call another tool if more evidence is needed or stop by writing a clean Markdown final answer for the user. Do not output raw JSON, raw tool responses, generated code, internal tool names, or MCP implementation details in the final answer. Interpret the data and include concrete PR or issue numbers, statuses, and next actions when present.",
      messages: conversation(this.state.messages, repo, prompt),
    })

    return {
      mcpCalls,
      result: cleanFinalText(result.text.trim()),
    }
  }

  private async githubTools(calls: ToolCall[], send?: StreamSend): Promise<ToolSet> {
    await this.mcp.waitForConnections({ timeout: 3_000 }).catch(() => undefined)
    return traceTools(readonlyTools(this.mcp.getAITools({ serverName: "github" })), calls, send)
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
      model: modelName(this.env),
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
  const agent = await getAgentByName<Env, GitHubAgent>(env.GitHubAgent, name)
  return agent.fetch(new Request(target, request))
}

function traceTools(tools: ToolSet, calls: ToolCall[], send?: StreamSend): ToolSet {
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
            send?.({ type: "message", message: message("assistant", `Calling \`${name}\`.`, [{ kind: "tools", title: "MCP call", calls: [call] }]) })
            try {
              const output = await execute(input, options)
              call.output = compact(output)
              send?.({ type: "message", message: message("assistant", `Finished \`${name}\`.`, [{ kind: "tools", title: "MCP result", calls: [call] }]) })
              return output
            } catch (error) {
              call.error = error instanceof Error ? error.message : String(error)
              send?.({ type: "message", message: message("assistant", `\`${name}\` failed.`, [{ kind: "tools", title: "MCP error", calls: [call] }]) })
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
    ...history.filter((entry) => !entry.transient).slice(-6).map((entry) => ({ role: entry.role, content: entry.text })),
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

function cleanFinalText(text: string): string {
  if (text && !looksRawJson(text)) return text
  return "I finished the repository inspection and found structured results. Expand the tool-call details for the raw data."
}

function languageModel(env: Env): LanguageModel {
  if (env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY })
    return openai(openaiModel)
  }

  const workersai = createWorkersAI({ binding: env.AI })
  return workersai(workersAiModel)
}

function modelName(env: Env): string {
  return env.OPENAI_API_KEY ? openaiModel : workersAiModel
}

function looksRawJson(text: string): boolean {
  if (!/^\s*[\[{]/.test(text)) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
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
