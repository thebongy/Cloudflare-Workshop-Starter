import { AIChatAgent } from "@cloudflare/ai-chat"
import { getAgentByName } from "agents"
import { generateText, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai"
import { createWorkersAI } from "workers-ai-provider"
import { z } from "zod"

type Message = { role: "user" | "assistant"; text: string; createdAt: string; artifacts?: MessageArtifact[] }
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
type MessageArtifact = {
  kind: "tools" | "logs" | "json" | "code"
  title: string
  language?: string
  code?: string
  data?: unknown
  lines?: string[]
  calls?: ToolTrace[]
}
type RunTrace = {
  mode: "direct-mcp"
  prompt: string
  repo: string
  startedAt: string
  completedAt: string
  generatedCode: null
  logs: string[]
  mcpCalls: ToolTrace[]
  result: string
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
  ASSETS: Fetcher
  GITHUB_MCP_PAT?: string
}

const stage = "stage-03-direct-mcp"
const githubMcpUrl = "https://api.githubcopilot.com/mcp/"
const modelName = "@cf/moonshotai/kimi-k2.5"

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

      const run = await this.runDirectMcp(prompt, repo)
      const text = run.result
      const artifacts = artifactsFromRun(run)
      const nextState: State = {
        ...this.state,
        selectedRepo: repo,
        mode: "direct-mcp",
        mcpConnection: { ...this.connectionFromMcp(), toolCount: run.toolCount, usingMock: run.usingMock },
        messages: [...this.state.messages, message("user", prompt), message("assistant", text, artifacts)].slice(-40),
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

  private async runDirectMcp(prompt: string, repo: string): Promise<RunTrace> {
    const startedAt = new Date().toISOString()
    const mcpCalls: ToolTrace[] = []
    const logs: string[] = ["mode=direct-mcp", "asking the model to call GitHub tools one at a time"]

    try {
      const github = await this.githubTools(mcpCalls)
      logs.push(github.usingMock ? "using seeded GitHub MCP fallback tools" : `using ${github.toolCount} read-only GitHub MCP tools`)

      const workersai = createWorkersAI({ binding: this.env.AI })
      const result = await generateText({
        model: workersai(modelName),
        tools: github.tools,
        stopWhen: stepCountIs(8),
        system:
          "You are a read-only GitHub maintainer assistant. Use the available GitHub MCP tools before answering. Prefer concise findings with concrete PR, issue, check, workflow, or release references. Continue using tools until you have enough evidence, then stop calling tools and answer the user.",
        messages: conversationMessages(this.state.messages, repo, prompt, "Use direct tool calls. Do not invent GitHub data."),
      })

      const text = result.text.trim() || summarizeUnknown(result.toolResults)
      logs.push(`agent loop steps=${result.steps.length}`, `direct tool calls=${mcpCalls.length}`, "agent loop stopped after final assistant response")
      return {
        mode: "direct-mcp",
        prompt,
        repo,
        startedAt,
        completedAt: new Date().toISOString(),
        generatedCode: null,
        logs,
        mcpCalls,
        result: text,
        usingMock: github.usingMock,
        toolCount: github.toolCount,
      }
    } catch (error) {
      logs.push(`model/tool loop failed: ${errorMessage(error)}`, "running deterministic seeded fallback for the workshop")
      const fallback = await directFallback(prompt, repo, mcpCalls)
      return {
        mode: "direct-mcp",
        prompt,
        repo,
        startedAt,
        completedAt: new Date().toISOString(),
        generatedCode: null,
        logs,
        mcpCalls,
        result: fallback,
        error: errorMessage(error),
        usingMock: true,
        toolCount: Object.keys(createMockGitHubTools()).length,
      }
    }
  }

  private async githubTools(mcpCalls: ToolTrace[]): Promise<{ tools: ToolSet; usingMock: boolean; toolCount: number }> {
    await this.mcp.waitForConnections({ timeout: 3_000 }).catch(() => undefined)
    const realTools = readonlyTools(this.mcp.getAITools({ serverName: "github" }))
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
    const toolCount = mcpState.tools.filter((toolEntry) => !id || toolEntry.serverId === id).length
    const status = String(server?.state ?? fallbackStatus)
    return {
      status,
      serverId: id,
      authUrl: server?.auth_url ?? fallbackAuthUrl,
      toolCount,
      readOnly: true,
      usingMock: status !== "ready" || toolCount === 0,
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
      stageLabel: "Direct MCP baseline",
      description: "Stage 03 passes GitHub MCP tools directly to Kimi and records each tool call in the inspector.",
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
              const output = await executable.execute?.(input, options)
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

async function directFallback(prompt: string, repo: string, traces: ToolTrace[]) {
  const { owner, name } = splitRepo(repo)
  const tools = instrumentTools(createMockGitHubTools(), traces)
  const openPulls = await callTool<typeof seedPullRequests>(tools, "listPullRequests", { owner, repo: name, state: "open" })
  const stalePulls = openPulls.filter((pull) => pull.daysSinceUpdate >= 14)
  const checks = await Promise.all(stalePulls.map((pull) => callTool<{ checks?: unknown[] }>(tools, "getPullRequestChecks", { owner, repo: name, pullNumber: pull.number })))
  const failing = stalePulls.filter((pull, index) => checks[index]?.checks?.some((check) => typeof check === "object" && check !== null && "conclusion" in check && check.conclusion === "failure"))

  if (prompt.toLowerCase().includes("release")) {
    const [tags, merged] = await Promise.all([
      callTool<typeof seedTags>(tools, "listTags", { owner, repo: name }),
      callTool<typeof seedMergedPullRequests>(tools, "listMergedPullRequests", { owner, repo: name, sinceTag: "v4.2026.4" }),
    ])
    return `Seeded fallback: latest tag is ${tags[0]?.name}. Release notes should include ${merged.map((pull) => `#${pull.number} ${pull.title}`).join("; ")}.`
  }

  return `Seeded fallback: ${failing.length} stale open PRs have failing checks. ${failing.map((pull) => `#${pull.number} ${pull.title} needs maintainer attention after ${pull.daysSinceUpdate} days`).join("; ")}.`
}

async function callTool<T>(tools: ToolSet, name: string, input: unknown): Promise<T> {
  const selected = tools[name] as { execute?: (input: unknown, options?: unknown) => Promise<unknown> } | undefined
  if (!selected?.execute) throw new Error(`Missing tool ${name}`)
  return (await selected.execute(input, { toolCallId: crypto.randomUUID() })) as T
}

function splitRepo(repo: string) {
  const [owner = "cloudflare", name = "workers-sdk"] = repo.split("/")
  return { owner, name }
}

function disconnectedConnection(): McpConnection {
  return { status: "disconnected", serverId: null, authUrl: null, toolCount: 0, readOnly: true, usingMock: true }
}

function message(role: Message["role"], text: string, artifacts: MessageArtifact[] = []): Message {
  return { role, text, artifacts, createdAt: new Date().toISOString() }
}

function artifactsFromRun(run: RunTrace): MessageArtifact[] {
  const artifacts: MessageArtifact[] = []
  if (run.mcpCalls.length > 0) artifacts.push({ kind: "tools", title: "GitHub MCP Calls", calls: run.mcpCalls })
  if (run.error) artifacts.push({ kind: "json", title: "Error", data: { error: run.error } })
  if (run.logs.length > 0) artifacts.push({ kind: "logs", title: "Agent Loop", lines: run.logs })
  return artifacts
}

function conversationMessages(history: Message[], repo: string, prompt: string, instruction: string): ModelMessage[] {
  const previous = history.slice(-8).map((entry) => ({
    role: entry.role,
    content: entry.text,
  }))
  return [
    ...previous,
    {
      role: "user",
      content: `Repository: ${repo}\nRequest: ${prompt}\n\n${instruction}`,
    },
  ] as ModelMessage[]
}

async function readJson(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function summarizeUnknown(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(compact(value), null, 2)
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
