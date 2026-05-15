import { createOpenAI } from "@ai-sdk/openai"
import { AIChatAgent } from "@cloudflare/ai-chat"
import { getAgentByName } from "agents"
import { generateText, type ModelMessage } from "ai"

type Message = {
  role: "user" | "assistant"
  text: string
  createdAt: string
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
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/callback") return this.handleMcpCallback(request)
    if (url.pathname === "/state") return Response.json(this.snapshot(await this.refreshMcp()))

    if (url.pathname === "/clear" && request.method === "POST") {
      const state = { ...this.state, messages: [], mcpConnection: this.connection() }
      this.setState(state)
      return Response.json(this.snapshot(state))
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      const { prompt, repo = this.state.selectedRepo } = await request.json<{ prompt?: string; repo?: string }>()
      if (!prompt) return Response.json({ error: "Missing prompt" }, { status: 400 })

      const text = await this.chat([
        { role: "system", content: "You are a concise GitHub assistant. Explain what the connected MCP tools can inspect; do not call tools yet." },
        ...this.state.messages.slice(-6).map((entry) => ({ role: entry.role, content: entry.text })),
        { role: "user", content: `Repository: ${repo}\nMCP status: ${this.state.mcpConnection.status}\n${prompt}` },
      ] as ModelMessage[])
      const messages = [...this.state.messages, message("user", prompt), message("assistant", text)].slice(-20)
      const state = { ...this.state, messages, selectedRepo: repo }
      this.setState(state)
      return Response.json(this.snapshot(state))
    }

    if (url.pathname === "/mcp/connect" && request.method === "POST") {
      const connection = await this.connectGitHubMcp(request)
      const state = { ...this.state, mcpConnection: connection }
      this.setState(state)
      return Response.json(this.snapshot(state))
    }

    if (url.pathname === "/mcp/status") {
      return Response.json(this.snapshot(await this.refreshMcp()))
    }

    if (url.pathname === "/mcp/disconnect" && request.method === "POST") {
      const connection = await this.disconnectGitHubMcp()
      const state = { ...this.state, mcpConnection: connection }
      this.setState(state)
      return Response.json(this.snapshot(state))
    }

    return Response.json({ error: "Not found" }, { status: 404 })
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
      toolCount: mcp.tools.filter((tool) => !id || tool.serverId === id).length,
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
      stage: "stage-02-github-mcp",
      stageLabel: "GitHub MCP connection",
      model: modelName(this.env),
      state,
    }
  }

  private async chat(messages: ModelMessage[]): Promise<string> {
    if (this.env.OPENAI_API_KEY) {
      const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY })
      const result = await generateText({ model: openai(openaiModel), messages })
      return result.text.trim()
    }

    const result = await this.env.AI.run(workersAiModel, { messages })
    return readText(result)
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

function disconnected(): McpConnection {
  return { status: "disconnected", serverId: null, authUrl: null, toolCount: 0 }
}

function githubHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "X-MCP-Readonly": "true" }
}

function message(role: Message["role"], text: string): Message {
  return { role, text, createdAt: new Date().toISOString() }
}

function readText(result: unknown): string {
  const record = result as { choices?: Array<{ message?: { content?: string }; text?: string }>; response?: string; text?: string }
  return record.choices?.[0]?.message?.content ?? record.choices?.[0]?.text ?? record.response ?? record.text ?? JSON.stringify(result)
}

function modelName(env: Env): string {
  return env.OPENAI_API_KEY ? openaiModel : workersAiModel
}
