import { AIChatAgent } from "@cloudflare/ai-chat"
import { DynamicWorkerExecutor } from "@cloudflare/codemode"
import { createCodeTool, type CodeOutput } from "@cloudflare/codemode/ai"
import { getAgentByName } from "agents"
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai"
import { createWorkersAI } from "workers-ai-provider"

type ToolCall = {
  name: string
  input: unknown
  output?: unknown
  error?: string
}

type Artifact =
  | { kind: "code"; title: string; code: string; language: "js" }
  | { kind: "tools"; title: string; calls: ToolCall[] }
  | { kind: "json"; title: string; data: unknown }

type Message = {
  role: "user" | "assistant"
  text: string
  createdAt: string
  artifacts?: Artifact[]
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
  lastRun: { generatedCode: string; mcpCalls: ToolCall[]; result: unknown; finalText: string } | null
}

interface Env extends Cloudflare.Env {
  AI: Ai
  GitHubAgent: DurableObjectNamespace<GitHubAgent>
  LOADER: WorkerLoader
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

      const run = await this.runCodeMode(prompt, repo)
      const messages = [...this.state.messages, message("user", prompt), message("assistant", run.finalText, artifacts(run))].slice(-20)
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

  private async runCodeMode(prompt: string, repo: string) {
    const mcpCalls: ToolCall[] = []
    const githubTools = await this.githubTools(mcpCalls)

    if (Object.keys(githubTools).length === 0) {
      const text = "GitHub MCP is not connected yet. Set GITHUB_MCP_PAT, restart Wrangler, and connect again."
      return { generatedCode: "", mcpCalls, result: null, finalText: text }
    }

    const codemode = createCodeTool({
      tools: githubTools,
      executor: new DynamicWorkerExecutor({ loader: this.env.LOADER, globalOutbound: null }),
      description: [
        "Execute code to answer the user's GitHub question.",
        "",
        "Available:",
        "{{types}}",
        "",
        "Write an async arrow function in JavaScript that returns the result.",
        "Call tools as codemode.<toolName>(args). Never use _.<toolName>().",
        "For open PR lists, prefer a list_pull_requests tool instead of search_pull_requests.",
        "GitHub MCP list tools often return arrays directly; do not assume a { data } wrapper unless the value has one.",
        "Use loops or Promise.all when useful. Return compact JSON. Do not mutate GitHub.",
      ].join("\n"),
    })
    const workersai = createWorkersAI({ binding: this.env.AI })
    const result = await generateText({
      model: workersai(model),
      tools: { codemode },
      toolChoice: { type: "tool", toolName: "codemode" },
      stopWhen: stepCountIs(1),
      system:
        "You are a read-only GitHub maintainer assistant. Use Code Mode for multi-step repository inspection. For open PR lists, use list_pull_requests; it returns an array directly. Treat GitHub MCP results as plain JSON.",
      messages: conversation(this.state.messages, repo, prompt),
    })

    const output = codeOutput(result)
    const generatedCode = generatedCodeFrom(result) ?? ""
    const structuredResult = output?.result ?? null
    const finalText = output ? format(structuredResult) : result.text.trim() || format(structuredResult)

    return { generatedCode, mcpCalls, result: structuredResult, finalText }
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
      stage: "stage-04-codemode",
      stageLabel: "Code Mode over GitHub MCP",
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
  const agent = await getAgentByName<Env, GitHubAgent>(env.GitHubAgent, name)
  return agent.fetch(new Request(target, request))
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
              const output = unwrapMcpText(await execute(input, options))
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

function codeOutput(result: unknown): CodeOutput | undefined {
  const typed = result as {
    toolResults?: Array<{ toolName?: string; output?: unknown }>
    steps?: Array<{ toolResults?: Array<{ toolName?: string; output?: unknown }> }>
  }
  const toolResults = [...(typed.toolResults ?? []), ...(typed.steps ?? []).flatMap((step) => step.toolResults ?? [])]
  for (const toolResult of toolResults) {
    if (toolResult.toolName === "codemode") return asCodeOutput(toolResult.output)
  }
  return undefined
}

function asCodeOutput(value: unknown): CodeOutput | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if ("result" in record) return record as CodeOutput
  return asCodeOutput(record.output)
}

function generatedCodeFrom(result: unknown): string | undefined {
  const record = findObject(result, (value) => typeof value.code === "string")
  return record?.code as string | undefined
}

function findObject(value: unknown, match: (value: Record<string, unknown>) => boolean, depth = 0): Record<string, unknown> | undefined {
  if (!value || depth > 8) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObject(item, match, depth + 1)
      if (found) return found
    }
    return undefined
  }
  if (typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (match(record)) return record
  for (const child of Object.values(record)) {
    const found = findObject(child, match, depth + 1)
    if (found) return found
  }
  return undefined
}

function unwrapMcpText(output: unknown): unknown {
  const content = (output as { content?: Array<{ type?: string; text?: string }> })?.content
  const text = content?.find((part) => part.type === "text")?.text
  if (!text) return output
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function artifacts(run: State["lastRun"]): Artifact[] {
  if (!run) return []
  return [
    ...(run.generatedCode ? [{ kind: "code" as const, title: "Generated code", language: "js" as const, code: run.generatedCode }] : []),
    { kind: "tools" as const, title: "GitHub MCP calls", calls: run.mcpCalls },
    { kind: "json" as const, title: "Result", data: run.result },
  ]
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

function message(role: Message["role"], text: string, artifacts: Artifact[] = []): Message {
  return { role, text, artifacts, createdAt: new Date().toISOString() }
}

function format(value: unknown): string {
  return value == null ? "Code Mode finished. Inspect the generated code and tool calls above." : JSON.stringify(value, null, 2)
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
