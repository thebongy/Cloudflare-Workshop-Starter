import { AIChatAgent } from "@cloudflare/ai-chat"
import { getAgentByName } from "agents"

type Message = { role: "user" | "assistant"; text: string; createdAt: string }
type State = {
  messages: Message[]
  selectedRepo: string
  mode: "direct-mcp" | "codemode"
  safetyMode: "readonly"
  mcpConnection: { status: string; toolCount: number; readOnly: boolean; usingMock: boolean }
  lastRun: unknown
}

interface Env extends Cloudflare.Env {
  AI: Ai
  GitHubAgent: DurableObjectNamespace<GitHubAgent>
  ASSETS: Fetcher
}

const stage = "stage-01-kimi-chat"

export class GitHubAgent extends AIChatAgent<Env, State> {
  initialState: State = {
    messages: [],
    selectedRepo: "cloudflare/workers-sdk",
    mode: "direct-mcp",
    safetyMode: "readonly",
    mcpConnection: { status: "disconnected", toolCount: 0, readOnly: true, usingMock: true },
    lastRun: null,
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/state" && request.method === "GET") {
      return Response.json(this.snapshot())
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
              "You are a concise GitHub repo assistant in Stage 01 of a Cloudflare workshop. MCP tools are not connected yet, so explain what you would inspect and ask for the next stage when live repo data is needed.",
          },
          ...this.state.messages.slice(-6).map((message) => ({ role: message.role, content: message.text })),
          { role: "user", content: `Repository: ${repo}\n${prompt}` },
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

    if (url.pathname.startsWith("/mcp/")) {
      return Response.json({ state: this.snapshot(), text: "GitHub MCP is added in Stage 02." })
    }

    return Response.json({ error: "Unknown endpoint" }, { status: 404 })
  }

  private snapshot(state: State = this.state) {
    return {
      stage,
      stageLabel: "Kimi chat agent",
      description: "The UI now talks to an AIChatAgent Durable Object using Workers AI Kimi K2.5.",
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
  const stub = await getAgentByName<Env, GitHubAgent>(env.GitHubAgent, name)
  return stub.fetch(new Request(new URL(targetPath, url.origin), request))
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
  if (typeof result === "string") return result
  if (!result || typeof result !== "object") return String(result)

  const record = result as Record<string, unknown>
  const choices = Array.isArray(record.choices) ? record.choices : []
  const firstChoice = choices[0] as Record<string, unknown> | undefined
  const message = firstChoice?.message as Record<string, unknown> | undefined
  if (typeof message?.content === "string") return message.content

  if (typeof record.response === "string") return record.response
  return JSON.stringify(result)
}
