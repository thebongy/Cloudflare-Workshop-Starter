import { AIChatAgent } from "@cloudflare/ai-chat"
import { getAgentByName } from "agents"

type Message = { role: "user" | "assistant"; text: string; createdAt: string; artifacts?: unknown[] }
type McpConnection = {
  status: string
  serverId: string | null
  authUrl: string | null
  toolCount: number
  readOnly: boolean
  usingMock: boolean
  error?: string
}
type State = {
  messages: Message[]
  selectedRepo: string
  mode: "direct-mcp" | "codemode"
  safetyMode: "readonly"
  mcpConnection: McpConnection
  lastRun: null
  runHistory: unknown[]
}

interface Env extends Cloudflare.Env {
  AI: Ai
  GitHubAgent: DurableObjectNamespace<GitHubAgent>
  ASSETS: Fetcher
  GITHUB_MCP_PAT?: string
}

const stage = "stage-02-github-mcp"
const githubMcpUrl = "https://api.githubcopilot.com/mcp/"

export class GitHubAgent extends AIChatAgent<Env, State> {
  initialState: State = {
    messages: [],
    selectedRepo: "cloudflare/workers-sdk",
    mode: "direct-mcp",
    safetyMode: "readonly",
    mcpConnection: disconnectedConnection(),
    lastRun: null,
    runHistory: [],
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/callback") {
      return this.handleMcpCallback(request)
    }

    if (url.pathname === "/state" && request.method === "GET") {
      const state = await this.refreshMcpStatus()
      return Response.json(this.snapshot(state))
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      const body = await readJson(request)
      const prompt = String(body.prompt ?? "").trim()
      const repo = String(body.repo ?? this.state.selectedRepo)
      if (!prompt) return Response.json({ error: "Missing prompt" }, { status: 400 })

      const result = await this.env.AI.run("@cf/moonshotai/kimi-k2.5", {
        messages: [
          {
            role: "system",
            content:
              "You are a concise GitHub repo assistant in Stage 02 of a Cloudflare workshop. GitHub MCP connection status is visible, but direct tool use is introduced in Stage 03. Explain what the connected tools will let the attendee inspect.",
          },
          ...this.state.messages.slice(-6).map((entry) => ({ role: entry.role, content: entry.text })),
          {
            role: "user",
            content: `Repository: ${repo}\nGitHub MCP status: ${this.state.mcpConnection.status}\n${prompt}`,
          },
        ],
      })

      const text = readModelText(result)
      const nextState: State = {
        ...this.state,
        selectedRepo: repo,
        messages: [...this.state.messages, message("user", prompt), message("assistant", text)].slice(-40),
      }
      this.setState(nextState)
      return Response.json({ state: this.snapshot(nextState), text })
    }

    if (url.pathname === "/mcp/connect" && request.method === "POST") {
      const connection = await this.connectGitHubMcp(request)
      const nextState: State = { ...this.state, mcpConnection: connection }
      this.setState(nextState)
      return Response.json({ state: this.snapshot(nextState), connection })
    }

    if (url.pathname === "/mcp/status" && request.method === "GET") {
      const state = await this.refreshMcpStatus()
      return Response.json({ state: this.snapshot(state), connection: state.mcpConnection })
    }

    if (url.pathname === "/mcp/disconnect" && request.method === "POST") {
      const connection = await this.disconnectGitHubMcp()
      const nextState: State = { ...this.state, mcpConnection: connection }
      this.setState(nextState)
      return Response.json({ state: this.snapshot(nextState), connection })
    }

    return Response.json({ error: "Unknown endpoint" }, { status: 404 })
  }

  private async connectGitHubMcp(request: Request): Promise<McpConnection> {
    if (!this.env.GITHUB_MCP_PAT) {
      return {
        ...this.state.mcpConnection,
        status: "needs_token",
        usingMock: true,
        error: "Set the GITHUB_MCP_PAT Worker secret to connect to GitHub's remote MCP server from this custom host.",
      }
    }

    try {
      const origin = new URL(request.url).origin
      const result = await this.addMcpServer("github", githubMcpUrl, {
        callbackHost: origin,
        callbackPath: "/api/agent/demo/callback",
        transport: { type: "streamable-http", headers: githubMcpHeaders(this.env.GITHUB_MCP_PAT) },
      })

      await this.mcp.waitForConnections({ timeout: 4_000 }).catch(() => undefined)
      return this.connectionFromMcp(result.id, result.state, "authUrl" in result ? result.authUrl : null)
    } catch (error) {
      return {
        ...this.state.mcpConnection,
        status: "error",
        usingMock: true,
        error: errorMessage(error),
      }
    }
  }

  private async disconnectGitHubMcp(): Promise<McpConnection> {
    const current = this.connectionFromMcp()
    if (current.serverId) {
      await this.removeMcpServer(current.serverId).catch(() => undefined)
    }
    return disconnectedConnection()
  }

  private async refreshMcpStatus(): Promise<State> {
    await this.mcp.waitForConnections({ timeout: 2_000 }).catch(() => undefined)
    const nextState: State = { ...this.state, mcpConnection: this.connectionFromMcp() }
    this.setState(nextState)
    return nextState
  }

  private connectionFromMcp(serverId?: string, fallbackStatus = "disconnected", fallbackAuthUrl: string | null = null): McpConnection {
    const mcpState = this.getMcpServers()
    const entries = Object.entries(mcpState.servers)
    const entry = serverId ? entries.find(([id]) => id === serverId) : entries.find(([, server]) => server.name === "github")
    const id = entry?.[0] ?? serverId ?? null
    const server = entry?.[1]
    const toolCount = mcpState.tools.filter((toolEntry) => !id || toolEntry.serverId === id).length
    const status = String(server?.state ?? fallbackStatus)
    const authUrl = server?.auth_url ?? fallbackAuthUrl
    return {
      status,
      serverId: id,
      authUrl,
      toolCount,
      readOnly: true,
      usingMock: status !== "ready" || toolCount === 0,
      error: server?.error ?? undefined,
    }
  }

  private async handleMcpCallback(request: Request): Promise<Response> {
    if (!this.mcp.isCallbackRequest(request)) {
      return Response.json({ error: "Not an MCP OAuth callback" }, { status: 400 })
    }
    const result = await this.mcp.handleCallbackRequest(request)
    if (result.authSuccess) {
      this.mcp.establishConnection(result.serverId).catch((error) => console.error("MCP connection failed", error))
    }
    const redirect = new URL("/", request.url)
    redirect.searchParams.set("mcp", result.authSuccess ? "connected" : "error")
    if (!result.authSuccess) redirect.searchParams.set("error", result.authError)
    return Response.redirect(redirect.href)
  }

  private snapshot(state: State = this.state) {
    return {
      stage,
      stageLabel: "GitHub MCP connection",
      description: "Stage 02 adds read-only GitHub MCP connect, status, disconnect, and OAuth callback routes.",
      state,
      model: "@cf/moonshotai/kimi-k2.5",
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/api/agent/")) return forwardToAgent(request, env)
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

async function forwardToAgent(request: Request, env: Env) {
  const url = new URL(request.url)
  const [, , , name = "demo", ...rest] = url.pathname.split("/")
  const targetPath = rest.length > 0 ? `/${rest.join("/")}` : "/state"
  const targetUrl = new URL(targetPath, url.origin)
  targetUrl.search = url.search
  const stub = await getAgentByName<Env, GitHubAgent>(env.GitHubAgent, name)
  return stub.fetch(new Request(targetUrl, request))
}

function disconnectedConnection(): McpConnection {
  return { status: "disconnected", serverId: null, authUrl: null, toolCount: 0, readOnly: true, usingMock: true }
}

function message(role: Message["role"], text: string): Message {
  return { role, text, createdAt: new Date().toISOString() }
}

async function readJson(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function readModelText(result: unknown) {
  return extractText(result) ?? "The model returned no text."
}

function extractText(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined
  if (typeof value === "string") return value.trim() || undefined

  if (Array.isArray(value)) {
    const parts = value.map((entry) => extractText(entry, depth + 1)).filter((entry): entry is string => Boolean(entry))
    return parts.length > 0 ? parts.join("\n") : undefined
  }

  if (typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const choices = Array.isArray(record.choices) ? record.choices : []
  const firstChoice = choices[0] as Record<string, unknown> | undefined
  const firstChoiceText = extractText(firstChoice?.message, depth + 1) ?? extractText(firstChoice?.text, depth + 1)
  if (firstChoiceText) return firstChoiceText

  for (const key of ["response", "text", "content", "answer", "output"]) {
    const text = extractText(record[key], depth + 1)
    if (text) return text
  }

  return undefined
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function githubMcpHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "X-MCP-Toolsets": "repos,issues,pull_requests,actions",
    "X-MCP-Readonly": "true",
  }
}
