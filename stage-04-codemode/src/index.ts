import { createOpenAI } from "@ai-sdk/openai"
import { AIChatAgent } from "@cloudflare/ai-chat"
import { DynamicWorkerExecutor } from "@cloudflare/codemode"
import { createCodeTool, type CodeOutput } from "@cloudflare/codemode/ai"
import { getAgentByName } from "agents"
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai"
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
  | { kind: "logs"; title: string; lines: string[] }

type Message = {
  role: "user" | "assistant"
  text: string
  createdAt: string
  artifacts?: Artifact[]
  transient?: boolean
}

type CodeRun = {
  generatedCode: string
  result: unknown
  logs: string[]
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
  lastRun: { generatedCode: string; mcpCalls: ToolCall[]; result: unknown; logs: string[]; finalText: string } | null
}

interface Env extends Cloudflare.Env {
  AI: Ai
  GitHubAgent: DurableObjectNamespace<GitHubAgent>
  LOADER: WorkerLoader
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

      return this.streamCodeModeChat(prompt, repo)
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

  private streamCodeModeChat(prompt: string, repo: string): Response {
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
            send({ type: "message", message: message("assistant", "Starting the Code Mode agent loop.") })
            const run = await this.runCodeMode(prompt, repo, send)
            const messages = [...this.state.messages, message("user", prompt), ...liveMessages, message("assistant", run.finalText, artifacts(run))].slice(-40)
            const state = { ...this.state, selectedRepo: repo, messages, lastRun: run, mcpConnection: this.connection() }
            this.setState(state)
            send({ type: "snapshot", snapshot: this.snapshot(state) })
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error)
            const run = { generatedCode: "", mcpCalls: [], result: null, logs: [], finalText: text }
            const messages = [...this.state.messages, message("user", prompt), ...liveMessages, message("assistant", text)].slice(-40)
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

  private async runCodeMode(prompt: string, repo: string, send?: StreamSend) {
    const mcpCalls: ToolCall[] = []
    const githubTools = await this.githubTools(mcpCalls, send)
    const codeRuns: CodeRun[] = []

    if (Object.keys(githubTools).length === 0) {
      const text = "GitHub MCP is not connected yet. Set GITHUB_MCP_PAT, restart Wrangler, and connect again."
      return { generatedCode: "", mcpCalls, result: null, logs: [], finalText: text }
    }

    const codemode = traceCodeTool(createCodeTool({
      tools: githubTools,
      executor: new DynamicWorkerExecutor({ loader: this.env.LOADER, globalOutbound: null }),
      description: [
        "Execute code to answer the user's GitHub question.",
        "",
        "Available:",
        "{{types}}",
        "",
        "Write one async arrow function in JavaScript that returns the result.",
        "Do not invoke that function; the executor calls it for you.",
        "Correct shape: async () => { const result = await codemode.someTool({}); return result; }",
        "Incorrect shape: async () => { const result = await codemode.someTool({}); return result; }()",
        "Do NOT use TypeScript syntax: no type annotations, interfaces, or generics.",
        "Call tools as codemode.<toolName>(args). Never use _.<toolName>().",
        "Prefer doing the whole investigation in one Code Mode run.",
        "Inside that program, call as many GitHub tools as needed.",
        "Use console.log/warn/error for useful checkpoints; logs are returned alongside your final value.",
        "Use loops, conditionals, local variables, and Promise.all to avoid extra model/tool turns.",
        "Write defensive JavaScript for GitHub JSON: fields like labels, users, comments, and checks can be missing.",
        "For stale PR prompts, fetch enough pages, filter drafts unless requested, sort by updated_at, and inspect details inside the same program.",
        "Return answer-ready JSON with selected items, evidence, and nextActions; do not return exploratory lists for the model to inspect later.",
        "For open PR lists, prefer a list_pull_requests tool instead of search_pull_requests.",
        "GitHub MCP list tools often return arrays directly; do not assume a { data } wrapper unless the value has one.",
        "Return compact JSON. Do not mutate GitHub.",
      ].join("\n"),
    }), codeRuns, send)
    const result = await generateText({
      model: languageModel(this.env),
      tools: { codemode },
      stopWhen: stepCountIs(8),
      prepareStep: ({ stepNumber }) => {
        const action = stepNumber === 0 ? "writing a Code Mode program." : "choosing whether to run Code Mode again or finish."
        send?.({ type: "message", message: message("assistant", `Agent turn ${stepNumber + 1}: ${action}`) })
        return stepNumber === 0 ? { toolChoice: { type: "tool", toolName: "codemode" } } : {}
      },
      system:
        "You are a read-only GitHub maintainer assistant. Use Code Mode for repository inspection. Prefer each Code Mode run to call as many GitHub MCP tools as needed inside the generated program, using loops and Promise.all instead of many model turns. Ask Code Mode to return answer-ready JSON with selected candidates, evidence, and suggested next actions, not exploratory lists. For open PR lists, use list_pull_requests; it returns an array directly. Treat GitHub MCP results as plain JSON and write defensive code because GitHub fields can be missing. Only run Code Mode again after a failed run or if the previous result is missing critical evidence; do not run it again just to re-rank or re-filter data you already have. When you have enough data, stop by writing a clean Markdown final answer for the user. Do not output raw JSON, raw tool responses, generated code, MCP tool names, or Code Mode implementation details in the final answer. Interpret the data and include concrete PR or issue numbers, statuses, and next actions when present.",
      messages: conversation(this.state.messages, repo, prompt),
    })

    const output = codeOutput(result)
    const generatedCode = codeRuns.map((run) => run.generatedCode).filter(Boolean).join("\n\n// --- next Code Mode run ---\n\n") || generatedCodeFrom(result) || ""
    const structuredResult = codeRuns.at(-1)?.result ?? output?.result ?? null
    const logs = codeRuns.flatMap((run) => run.logs)
    const finalText = cleanFinalText(result.text.trim(), structuredResult)

    return { generatedCode, mcpCalls, result: structuredResult, logs, finalText }
  }

  private async githubTools(calls: ToolCall[], send?: StreamSend): Promise<ToolSet> {
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

function traceCodeTool(tool: ToolSet[string], runs: CodeRun[], send?: StreamSend): ToolSet[string] {
  const execute = (tool as { execute?: (input: unknown, options: unknown) => Promise<unknown> }).execute
  if (!execute) return tool

  return {
    ...tool,
    execute: async (input: unknown, options: unknown) => {
      const generatedBeforeRun = generatedCodeFrom(input) ?? ""
      if (generatedBeforeRun) {
        send?.({
          type: "message",
          message: message("assistant", "Generated a Code Mode program.", [
            { kind: "code", title: "Generated code", language: "js", code: generatedBeforeRun },
          ]),
        })
      } else {
        send?.({ type: "message", message: message("assistant", "Executing a Code Mode program.") })
      }

      try {
        const output = await execute(input, options)
        const codeOutput = asCodeOutput(output)
        const generatedCode = generatedCodeFrom(output) ?? generatedBeforeRun
        const result = codeOutput?.result ?? output
        const logs = codeOutput?.logs ?? []
        runs.push({ generatedCode, result, logs })
        send?.({
          type: "message",
          message: message("assistant", "Code Mode run finished.", [
            ...(generatedCode ? [{ kind: "code" as const, title: "Generated code", language: "js" as const, code: generatedCode }] : []),
            ...(logs.length ? [{ kind: "logs" as const, title: "Console logs", lines: logs }] : []),
            { kind: "json", title: "Code Mode result", data: result },
          ]),
        })
        return output
      } catch (error) {
        const generatedCode = generatedBeforeRun
        const { message: errorMessage, logs } = codeModeError(error)
        const result = {
          failed: true,
          error: errorMessage,
          logs,
          nextAction: "The agent can inspect this result and run a corrected Code Mode program.",
        }
        const output = { result, logs }
        runs.push({ generatedCode, result, logs })
        send?.({
          type: "message",
          message: message("assistant", "Code Mode run failed.", [
            ...(generatedCode ? [{ kind: "code" as const, title: "Generated code", language: "js" as const, code: generatedCode }] : []),
            ...(logs.length ? [{ kind: "logs" as const, title: "Console logs", lines: logs }] : []),
            { kind: "json", title: "Code Mode result", data: result },
          ]),
        })
        return output
      }
    },
  }
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

function codeModeError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = "\n\nConsole output:\n"
  const markerIndex = raw.indexOf(marker)
  if (markerIndex === -1) return { message: raw, logs: [] }

  const message = raw.slice(0, markerIndex)
  const logs = raw
    .slice(markerIndex + marker.length)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

  return { message, logs }
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
    ...(run.logs.length ? [{ kind: "logs" as const, title: "Console logs", lines: run.logs }] : []),
    { kind: "json" as const, title: "Result", data: run.result },
  ]
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

function message(role: Message["role"], text: string, artifacts: Artifact[] = []): Message {
  return { role, text, artifacts, createdAt: new Date().toISOString() }
}

function format(value: unknown): string {
  return value == null ? "Code Mode finished. Expand Result for details." : JSON.stringify(value, null, 2)
}

function cleanFinalText(text: string, value: unknown): string {
  if (text && !looksRawJson(text)) return text
  if (value == null) return "I finished the repository inspection, but there was not enough structured data to summarize cleanly."
  return "I finished the repository inspection and found structured results. Expand the Result section for the raw details."
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
