import { AIChatAgent } from "@cloudflare/ai-chat"
import { DynamicWorkerExecutor } from "@cloudflare/codemode"
import { createCodeTool, resolveProvider, type CodeOutput } from "@cloudflare/codemode/ai"
import { getAgentByName } from "agents"
import { generateText, stepCountIs, tool, type ToolSet } from "ai"
import { createWorkersAI } from "workers-ai-provider"
import { z } from "zod"

type Message = { role: "user" | "assistant"; text: string; createdAt: string }
type McpConnection = {
  status: string
  serverId: string | null
  authUrl: string | null
  toolCount: number
  readOnly: boolean
  usingMock: boolean
  error?: string
}
type ToolTrace = {
  name: string
  input: unknown
  output?: unknown
  error?: string
  startedAt: string
  completedAt?: string
}
type RunTrace = {
  mode: "codemode"
  prompt: string
  repo: string
  startedAt: string
  completedAt: string
  generatedCode: string
  logs: string[]
  mcpCalls: ToolTrace[]
  result: unknown
  finalText: string
  error?: string
  usingMock: boolean
  toolCount: number
}
type State = {
  messages: Message[]
  selectedRepo: string
  mode: "direct-mcp" | "codemode"
  safetyMode: "readonly"
  mcpConnection: McpConnection
  lastRun: RunTrace | null
  runHistory: RunTrace[]
}

interface Env extends Cloudflare.Env {
  AI: Ai
  GitHubAgent: DurableObjectNamespace<GitHubAgent>
  LOADER: WorkerLoader
  ASSETS: Fetcher
  GITHUB_MCP_PAT?: string
}

const stage = "stage-04-codemode"
const githubMcpUrl = "https://api.githubcopilot.com/mcp/"
const modelName = "@cf/moonshotai/kimi-k2.5"

export class GitHubAgent extends AIChatAgent<Env, State> {
  initialState: State = {
    messages: [],
    selectedRepo: "cloudflare/workers-sdk",
    mode: "codemode",
    safetyMode: "readonly",
    mcpConnection: disconnectedConnection(),
    lastRun: null,
    runHistory: [],
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/callback") return this.handleMcpCallback(request)

    if (url.pathname === "/state" && request.method === "GET") {
      const state = await this.refreshMcpStatus()
      return Response.json(this.snapshot(state))
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      const body = await readJson(request)
      const prompt = String(body.prompt ?? "").trim()
      const repo = String(body.repo ?? this.state.selectedRepo)
      if (!prompt) return Response.json({ error: "Missing prompt" }, { status: 400 })

      const run = await this.runCodeMode(prompt, repo)
      const text = run.finalText
      const nextState: State = {
        ...this.state,
        selectedRepo: repo,
        mode: "codemode",
        mcpConnection: { ...this.connectionFromMcp(), toolCount: run.toolCount, usingMock: run.usingMock },
        messages: [...this.state.messages, message("user", prompt), message("assistant", text)].slice(-40),
        lastRun: run,
        runHistory: [run, ...this.state.runHistory].slice(0, 8),
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

  private async runCodeMode(prompt: string, repo: string): Promise<RunTrace> {
    const startedAt = new Date().toISOString()
    const mcpCalls: ToolTrace[] = []
    const logs: string[] = ["mode=codemode", "wrapping GitHub MCP tools with createCodeTool()", "sandbox outbound network access is disabled"]

    try {
      const github = await this.githubTools(mcpCalls)
      logs.push(github.usingMock ? "using seeded GitHub MCP fallback tools" : `using ${github.toolCount} read-only GitHub MCP tools`)

      const executor = new DynamicWorkerExecutor({
        loader: this.env.LOADER,
        globalOutbound: null,
        timeout: 30_000,
      })
      const codemode = createCodeTool({
        tools: github.tools,
        executor,
        description:
          "Execute JavaScript to answer a read-only GitHub maintenance question.\n\nAvailable:\n{{types}}\n\nWrite an async arrow function in JavaScript and return the function itself; do not invoke it with (). Use codemode.* calls, loops, filters, Promise.all, and return compact JSON. GitHub MCP tool results are normalized to parsed JSON when possible. If a result still has MCP content text, parse that text before filtering. Do not assume GitHub REST envelopes like { data } unless the type says so. Do not use fetch or mutate GitHub.",
      })
      const workersai = createWorkersAI({ binding: this.env.AI })
      const result = await generateText({
        model: workersai(modelName),
        tools: { codemode },
        toolChoice: { type: "tool", toolName: "codemode" },
        stopWhen: stepCountIs(1),
        system:
          "You are a read-only GitHub maintainer assistant. Prefer Code Mode for multi-step GitHub inspection. The generated program should be an async arrow function, not an immediately invoked expression. It should do the GitHub calls and return compact structured evidence. GitHub MCP results are usually plain JSON arrays or objects in this workshop; if a result has content text, parse the JSON text before reading fields.",
        prompt: `Repository: ${repo}\nRequest: ${prompt}\n\nUse Code Mode. Do not invent GitHub data.`,
      })

      const codeOutput = extractCodeOutput(result)
      const generatedCode = codeOutput?.code ?? extractGeneratedCode(result) ?? "No Code Mode output was captured."
      const fallbackResult = summarizeToolCalls(mcpCalls)
      const runResult = codeOutput?.result ?? fallbackResult
      const finalText = result.text.trim() || stringifyResult(runResult)
      const sandboxLogs = codeOutput?.logs ?? []
      logs.push(...sandboxLogs.map((entry) => `sandbox: ${entry}`), `codemode-output-captured=${Boolean(codeOutput)}`, `codemode-host-calls=${mcpCalls.length}`)

      return {
        mode: "codemode",
        prompt,
        repo,
        startedAt,
        completedAt: new Date().toISOString(),
        generatedCode,
        logs,
        mcpCalls,
        result: runResult,
        finalText,
        usingMock: github.usingMock,
        toolCount: github.toolCount,
      }
    } catch (error) {
      logs.push(`model/codemode tool loop failed: ${errorMessage(error)}`, "executing a deterministic Code Mode fallback over seeded GitHub tools")
      return this.runFallbackCodeMode(prompt, repo, startedAt, logs, mcpCalls, errorMessage(error))
    }
  }

  private async runFallbackCodeMode(prompt: string, repo: string, startedAt: string, logs: string[], mcpCalls: ToolTrace[], initialError: string): Promise<RunTrace> {
    const mockTools = instrumentTools(createMockGitHubTools(), mcpCalls)
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER, globalOutbound: null, timeout: 30_000 })
    const code = fallbackProgram(repo, prompt)

    try {
      const output = await executor.execute(code, [resolveProvider({ tools: mockTools })])
      logs.push(...(output.logs ?? []).map((entry) => `sandbox: ${entry}`), `codemode-host-calls=${mcpCalls.length}`)
      const finalText = output.error ? `Code Mode fallback returned an error: ${output.error}` : stringifyResult(output.result)
      return {
        mode: "codemode",
        prompt,
        repo,
        startedAt,
        completedAt: new Date().toISOString(),
        generatedCode: code,
        logs,
        mcpCalls,
        result: output.error ? { error: output.error } : output.result,
        finalText,
        error: initialError,
        usingMock: true,
        toolCount: Object.keys(createMockGitHubTools()).length,
      }
    } catch (fallbackError) {
      const finalText = `Code Mode fallback failed: ${errorMessage(fallbackError)}`
      logs.push(finalText)
      return {
        mode: "codemode",
        prompt,
        repo,
        startedAt,
        completedAt: new Date().toISOString(),
        generatedCode: code,
        logs,
        mcpCalls,
        result: { error: finalText },
        finalText,
        error: initialError,
        usingMock: true,
        toolCount: Object.keys(createMockGitHubTools()).length,
      }
    }
  }

  private async githubTools(mcpCalls: ToolTrace[]): Promise<{ tools: ToolSet; usingMock: boolean; toolCount: number }> {
    await this.mcp.waitForConnections({ timeout: 3_000 }).catch(() => undefined)
    const scopedTools = readonlyTools(this.mcp.getAITools({ serverName: "github" }))
    const realTools = Object.keys(scopedTools).length > 0 ? scopedTools : readonlyTools(this.mcp.getAITools())
    if (Object.keys(realTools).length > 0) {
      return { tools: instrumentTools(realTools, mcpCalls), usingMock: false, toolCount: Object.keys(realTools).length }
    }
    const mockTools = createMockGitHubTools()
    return { tools: instrumentTools(mockTools, mcpCalls), usingMock: true, toolCount: Object.keys(mockTools).length }
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
      return { ...this.state.mcpConnection, status: "error", usingMock: true, error: errorMessage(error) }
    }
  }

  private async disconnectGitHubMcp(): Promise<McpConnection> {
    const current = this.connectionFromMcp()
    if (current.serverId) await this.removeMcpServer(current.serverId).catch(() => undefined)
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
    const stateToolCount = mcpState.tools.filter((toolEntry) => !id || toolEntry.serverId === id).length
    const scopedToolCount = Object.keys(readonlyTools(this.mcp.getAITools({ serverName: "github" }))).length
    const aiToolCount = scopedToolCount || Object.keys(readonlyTools(this.mcp.getAITools())).length
    const toolCount = Math.max(stateToolCount, aiToolCount)
    const status = String(server?.state ?? fallbackStatus)
    const connected = status === "ready" || status === "connected"
    return {
      status,
      serverId: id,
      authUrl: server?.auth_url ?? fallbackAuthUrl,
      toolCount,
      readOnly: true,
      usingMock: !connected || toolCount === 0,
      error: server?.error ?? undefined,
    }
  }

  private async handleMcpCallback(request: Request): Promise<Response> {
    if (!this.mcp.isCallbackRequest(request)) return Response.json({ error: "Not an MCP OAuth callback" }, { status: 400 })
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
      stageLabel: "Code Mode over GitHub MCP",
      description: "Stage 04 wraps GitHub MCP tools with createCodeTool and executes generated JavaScript in a Dynamic Worker sandbox.",
      state,
      model: modelName,
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

function extractCodeOutput(result: unknown): CodeOutput | undefined {
  if (!result || typeof result !== "object") return undefined
  const typed = result as { toolResults?: Array<{ toolName?: string; output?: unknown }>; steps?: Array<{ toolResults?: Array<{ toolName?: string; output?: unknown }> }>; response?: { messages?: unknown[] } }
  const toolResults = [...(typed.toolResults ?? []), ...(typed.steps ?? []).flatMap((step) => step.toolResults ?? [])]
  for (const entry of toolResults) {
    const output = extractCodeOutputFromValue(entry.output)
    if (entry.toolName === "codemode" && output) return output
  }
  return extractCodeOutputFromValue(typed.response?.messages)
}

function extractCodeOutputFromValue(value: unknown, depth = 0): CodeOutput | undefined {
  if (!value || typeof value !== "object" || depth > 8) return undefined
  if ("code" in value && "result" in value) return value as CodeOutput

  if (Array.isArray(value)) {
    for (const item of value) {
      const output = extractCodeOutputFromValue(item, depth + 1)
      if (output) return output
    }
    return undefined
  }

  const record = value as Record<string, unknown>
  for (const key of ["output", "result", "content", "parts"]) {
    const output = extractCodeOutputFromValue(record[key], depth + 1)
    if (output) return output
  }
  return undefined
}

function extractGeneratedCode(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined
  const typed = result as { toolCalls?: Array<{ toolName?: string; input?: unknown }>; steps?: Array<{ toolCalls?: Array<{ toolName?: string; input?: unknown }> }>; response?: { messages?: unknown[] } }
  const calls = [...(typed.toolCalls ?? []), ...(typed.steps ?? []).flatMap((step) => step.toolCalls ?? [])]
  const direct = calls.find((entry) => entry.toolName === "codemode")
  const directCode = extractCodeString(direct?.input)
  if (directCode) return directCode
  return extractCodeString(typed.response?.messages)
}

function extractCodeString(value: unknown, depth = 0): string | undefined {
  if (!value || depth > 8) return undefined
  if (typeof value === "string") return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = extractCodeString(item, depth + 1)
      if (code) return code
    }
    return undefined
  }
  if (typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.code === "string") return record.code
  for (const key of ["input", "args", "arguments", "content", "parts"]) {
    const code = extractCodeString(record[key], depth + 1)
    if (code) return code
  }
  return undefined
}

function readonlyTools(tools: ToolSet): ToolSet {
  const blockedVerbs = ["add", "assign", "cancel", "close", "create", "delete", "disable", "dispatch", "edit", "enable", "lock", "merge", "patch", "post", "put", "remove", "reopen", "request", "rerun", "set", "submit", "unassign", "unlock", "update", "write"]
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => {
      const normalized = name.toLowerCase().replaceAll("-", "_")
      return !blockedVerbs.some((verb) => normalized === verb || normalized.startsWith(`${verb}_`) || normalized.includes(`_${verb}_`))
    }),
  ) as ToolSet
}

function instrumentTools(tools: ToolSet, traces: ToolTrace[]): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, current]) => {
      const executable = current as { execute?: (input: unknown, options?: unknown) => Promise<unknown> }
      if (!executable.execute) return [name, current]
      return [
        name,
        {
          ...current,
          execute: async (input: unknown, options?: unknown) => {
            const trace: ToolTrace = { name, input: compact(input), startedAt: new Date().toISOString() }
            traces.push(trace)
            try {
              const output = unwrapMcpToolOutput(await executable.execute?.(input, options))
              trace.output = compact(output)
              return output
            } catch (error) {
              trace.error = errorMessage(error)
              throw error
            } finally {
              trace.completedAt = new Date().toISOString()
            }
          },
        },
      ]
    }),
  ) as ToolSet
}

function createMockGitHubTools(): ToolSet {
  return {
    listPullRequests: mockTool({
      description: "List pull requests for a repository. Returns PullRequest[] directly, not a GitHub REST data envelope. Read-only seeded GitHub MCP fallback.",
      inputSchema: z.object({ owner: z.string(), repo: z.string(), state: z.enum(["open", "closed"]).optional() }),
      outputSchema: z.array(pullRequestOutputSchema),
      execute: async (input: unknown) => {
        const { state = "open" } = input as { state?: "open" | "closed" }
        return seedPullRequests.filter((pull) => pull.state === state)
      },
    }),
    getPullRequestChecks: mockTool({
      description: "Get check status for a pull request. Returns { state, checks } directly, where checks is CheckRun[]. Read-only seeded GitHub MCP fallback.",
      inputSchema: z.object({ owner: z.string(), repo: z.string(), pullNumber: z.number() }),
      outputSchema: checksOutputSchema,
      execute: async (input: unknown) => {
        const { pullNumber } = input as { pullNumber: number }
        const checks = seedPullRequests.find((pull) => pull.number === pullNumber)?.checks ?? []
        return {
          state: checks.some((check) => check.conclusion === "failure") ? "failure" : "success",
          checks,
        }
      },
    }),
    listWorkflowRuns: mockTool({
      description: "List recent workflow runs. Returns WorkflowRun[] directly. Read-only seeded GitHub MCP fallback.",
      inputSchema: z.object({ owner: z.string(), repo: z.string(), conclusion: z.enum(["success", "failure", "cancelled"]).optional() }),
      outputSchema: z.array(workflowRunOutputSchema),
      execute: async (input: unknown) => {
        const { conclusion } = input as { conclusion?: "success" | "failure" | "cancelled" }
        return seedWorkflowRuns.filter((run) => !conclusion || run.conclusion === conclusion)
      },
    }),
    listIssues: mockTool({
      description: "List issues that match a topic. Returns Issue[] directly. Read-only seeded GitHub MCP fallback.",
      inputSchema: z.object({ owner: z.string(), repo: z.string(), query: z.string().optional() }),
      outputSchema: z.array(issueOutputSchema),
      execute: async (input: unknown) => {
        const { query } = input as { query?: string }
        const q = query?.toLowerCase() ?? ""
        return seedIssues.filter((issue) => !q || issue.title.toLowerCase().includes(q) || issue.body.toLowerCase().includes(q))
      },
    }),
    listMergedPullRequests: mockTool({
      description: "List merged PRs since a tag. Returns MergedPullRequest[] directly. Read-only seeded GitHub MCP fallback.",
      inputSchema: z.object({ owner: z.string(), repo: z.string(), sinceTag: z.string().optional() }),
      outputSchema: z.array(mergedPullRequestOutputSchema),
      execute: async () => seedMergedPullRequests,
    }),
    listTags: mockTool({
      description: "List recent repository tags. Returns Tag[] directly. Read-only seeded GitHub MCP fallback.",
      inputSchema: z.object({ owner: z.string(), repo: z.string() }),
      outputSchema: z.array(tagOutputSchema),
      execute: async () => seedTags,
    }),
  }
}

function mockTool(config: Record<string, unknown>) {
  return tool(config as never) as ToolSet[string]
}

const checkOutputSchema = z.object({
  name: z.string(),
  conclusion: z.enum(["success", "failure"]),
  summary: z.string(),
})

const pullRequestOutputSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  author: z.string(),
  updatedAt: z.string(),
  daysSinceUpdate: z.number(),
  labels: z.array(z.string()),
  checks: z.array(checkOutputSchema),
})

const checksOutputSchema = z.object({
  state: z.enum(["success", "failure"]),
  checks: z.array(checkOutputSchema),
})

const workflowRunOutputSchema = z.object({
  id: z.number(),
  workflow: z.string(),
  branch: z.string(),
  conclusion: z.enum(["success", "failure", "cancelled"]),
  title: z.string(),
  failedStep: z.string().nullable(),
  logExcerpt: z.string(),
})

const issueOutputSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
})

const mergedPullRequestOutputSchema = z.object({
  number: z.number(),
  title: z.string(),
  mergedAt: z.string(),
})

const tagOutputSchema = z.object({
  name: z.string(),
  date: z.string(),
})

function fallbackProgram(repo: string, prompt: string) {
  const { owner, name } = splitRepo(repo)
  if (prompt.toLowerCase().includes("release")) {
    return `async () => {
  const [tags, merged] = await Promise.all([
    codemode.listTags({ owner: ${JSON.stringify(owner)}, repo: ${JSON.stringify(name)} }),
    codemode.listMergedPullRequests({ owner: ${JSON.stringify(owner)}, repo: ${JSON.stringify(name)}, sinceTag: "v4.2026.4" })
  ]);

  return {
    latestTag: tags[0],
    releaseNotes: merged.map((pull) => ({
      pull: "#" + pull.number,
      title: pull.title,
      mergedAt: pull.mergedAt
    }))
  };
}`
  }

  if (prompt.toLowerCase().includes("workflow")) {
    return `async () => {
  const failures = await codemode.listWorkflowRuns({
    owner: ${JSON.stringify(owner)},
    repo: ${JSON.stringify(name)},
    conclusion: "failure"
  });

  return failures.map((run) => ({
    workflow: run.workflow,
    branch: run.branch,
    likelyRootCause: run.logExcerpt,
    failedStep: run.failedStep
  }));
}`
  }

  return `async () => {
  const openPulls = await codemode.listPullRequests({
    owner: ${JSON.stringify(owner)},
    repo: ${JSON.stringify(name)},
    state: "open"
  });

  const stale = openPulls.filter((pull) => pull.daysSinceUpdate >= 14);
  const checks = await Promise.all(
    stale.map((pull) =>
      codemode.getPullRequestChecks({
        owner: ${JSON.stringify(owner)},
        repo: ${JSON.stringify(name)},
        pullNumber: pull.number
      })
    )
  );

  return stale
    .map((pull, index) => ({
      pull: "#" + pull.number,
      title: pull.title,
      daysSinceUpdate: pull.daysSinceUpdate,
      failingChecks: checks[index].checks.filter((check) => check.conclusion === "failure")
    }))
    .filter((pull) => pull.failingChecks.length > 0);
}`
}

function splitRepo(repo: string) {
  const [owner = "cloudflare", name = "workers-sdk"] = repo.split("/")
  return { owner, name }
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

function stringifyResult(value: unknown) {
  if (value === undefined) return "No structured result was returned."
  return typeof value === "string" ? value : JSON.stringify(compact(value), null, 2)
}

function summarizeToolCalls(calls: ToolTrace[]) {
  return {
    summary: calls.length > 0 ? `Code Mode completed ${calls.length} GitHub MCP call${calls.length === 1 ? "" : "s"}. Inspect the Calls tab for the raw evidence.` : "Code Mode completed without recorded GitHub MCP calls.",
    calls: calls.map((call) => ({ name: call.name, input: call.input, error: call.error })),
  }
}

function unwrapMcpToolOutput(output: unknown): unknown {
  if (!output || typeof output !== "object" || !("content" in output)) return output
  const content = (output as { content?: unknown }).content
  if (!Array.isArray(content)) return output

  const text = content.find((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
  const raw = text && typeof text === "object" ? (text as { text: string }).text : null
  if (!raw) return output

  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function compact(value: unknown) {
  try {
    const text = JSON.stringify(value)
    if (text.length > 4_000) return `${text.slice(0, 4_000)}...`
    return JSON.parse(text) as unknown
  } catch {
    return String(value)
  }
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

const seedPullRequests = [
  {
    number: 4812,
    title: "Fix Pages asset routing regression",
    state: "open",
    author: "mara",
    updatedAt: "2026-04-22T10:20:00Z",
    daysSinceUpdate: 22,
    labels: ["bug", "needs-maintainer"],
    checks: [
      { name: "unit", conclusion: "success", summary: "812 tests passed" },
      { name: "integration-pages", conclusion: "failure", summary: "asset routing fixture returns 404" },
    ],
  },
  {
    number: 4799,
    title: "Bump miniflare runtime snapshot",
    state: "open",
    author: "devin",
    updatedAt: "2026-04-18T15:11:00Z",
    daysSinceUpdate: 26,
    labels: ["dependencies"],
    checks: [{ name: "ci", conclusion: "success", summary: "all checks passed" }],
  },
  {
    number: 4760,
    title: "Add OAuth callback docs for Agents MCP",
    state: "open",
    author: "lina",
    updatedAt: "2026-04-10T08:30:00Z",
    daysSinceUpdate: 34,
    labels: ["docs", "needs-review"],
    checks: [{ name: "docs-links", conclusion: "failure", summary: "broken anchor in agents/mcp-client.md" }],
  },
] as const

const seedWorkflowRuns = [
  { id: 98701, workflow: "integration-pages", branch: "fix-pages-routing", conclusion: "failure", title: "Pages asset routing regression", failedStep: "asset routing fixture", logExcerpt: "expected 200 but received 404 for /assets/app.js" },
  { id: 98644, workflow: "docs-links", branch: "agents-mcp-docs", conclusion: "failure", title: "Docs link validation", failedStep: "check anchors", logExcerpt: "agents/mcp-client.md#oauth-callback was not found" },
  { id: 98588, workflow: "unit", branch: "main", conclusion: "success", title: "main unit test sweep", failedStep: null, logExcerpt: "" },
] as const

const seedIssues = [
  { number: 2201, title: "Authentication fails after GitHub OAuth callback", body: "Agent returns to the app but MCP status remains authenticating.", labels: ["auth", "agents"] },
  { number: 2194, title: "OAuth callback loses query string in custom agent route", body: "Custom /api/agent/demo/callback route drops code and state.", labels: ["auth", "routing"] },
  { number: 2175, title: "Workers AI stream closes early on long GitHub summaries", body: "Long release note generation sometimes stops after the first paragraph.", labels: ["ai"] },
] as const

const seedMergedPullRequests = [
  { number: 4742, title: "Add Kimi K2.5 examples for Workers AI", mergedAt: "2026-05-06T12:00:00Z" },
  { number: 4731, title: "Expose MCP connection status in Agents SDK", mergedAt: "2026-05-04T09:24:00Z" },
  { number: 4708, title: "Document worker_loaders for Dynamic Workers", mergedAt: "2026-04-30T18:47:00Z" },
] as const

const seedTags = [
  { name: "v4.2026.4", date: "2026-04-29T00:00:00Z" },
  { name: "v4.2026.3", date: "2026-03-27T00:00:00Z" },
] as const
