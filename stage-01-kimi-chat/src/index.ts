import { AIChatAgent } from "@cloudflare/ai-chat"
import { getAgentByName } from "agents"

type Message = {
  role: "user" | "assistant"
  text: string
  createdAt: string
}

type State = {
  messages: Message[]
  selectedRepo: string
}

interface Env extends Cloudflare.Env {
  AI: Ai
  GitHubAgent: DurableObjectNamespace<GitHubAgent>
  ASSETS: Fetcher
}

const model = "@cf/moonshotai/kimi-k2.5"

export class GitHubAgent extends AIChatAgent<Env, State> {
  initialState: State = {
    messages: [],
    selectedRepo: "cloudflare/workers-sdk",
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/state") return Response.json(this.snapshot())

    if (url.pathname === "/chat" && request.method === "POST") {
      const { prompt, repo = this.state.selectedRepo } = await request.json<{ prompt?: string; repo?: string }>()
      if (!prompt) return Response.json({ error: "Missing prompt" }, { status: 400 })

      const result = await this.env.AI.run(model, {
        messages: [
          { role: "system", content: "You are a concise GitHub repository assistant. MCP tools are added in later stages." },
          ...this.state.messages.slice(-6).map((entry) => ({ role: entry.role, content: entry.text })),
          { role: "user", content: `Repository: ${repo}\n${prompt}` },
        ],
      })

      const text = readText(result)
      const messages = [...this.state.messages, message("user", prompt), message("assistant", text)].slice(-20)
      this.setState({ messages, selectedRepo: repo })
      return Response.json(this.snapshot({ messages, selectedRepo: repo }))
    }

    return Response.json({ error: "Not found" }, { status: 404 })
  }

  private snapshot(state = this.state) {
    return {
      stage: "stage-01-kimi-chat",
      stageLabel: "Kimi chat agent",
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
  const stub = await getAgentByName<Env, GitHubAgent>(env.GitHubAgent, name)
  return stub.fetch(new Request(new URL(path, url.origin), request))
}

function message(role: Message["role"], text: string): Message {
  return { role, text, createdAt: new Date().toISOString() }
}

function readText(result: unknown): string {
  const record = result as { choices?: Array<{ message?: { content?: string }; text?: string }>; response?: string; text?: string }
  return record.choices?.[0]?.message?.content ?? record.choices?.[0]?.text ?? record.response ?? record.text ?? JSON.stringify(result)
}
