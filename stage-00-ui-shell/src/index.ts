const stage = "stage-00-ui-shell"

type Message = {
  role: "user" | "assistant"
  text: string
}

const state = {
  stage,
  stageLabel: "Worker + UI shell",
  description: "A standalone Worker serves the workshop UI before any model, Agent, or MCP code exists.",
  selectedRepo: "cloudflare/workers-sdk",
  mode: "direct-mcp",
  safetyMode: "readonly",
  mcpConnection: { status: "disconnected", toolCount: 0, readOnly: true, usingMock: true },
  messages: [] as Message[],
  lastRun: null,
}

interface Env {
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/api/agent/demo/state" && request.method === "GET") {
      return Response.json({ state, endpoints: endpoints(url.origin) })
    }

    if (url.pathname === "/api/agent/demo/chat" && request.method === "POST") {
      const body = await readJson(request)
      const prompt = String(body.prompt ?? "").trim()
      const text =
        "Stage 00 is just the UI shell. Next we add an AIChatAgent Durable Object and Kimi K2.5 so this same chat box speaks to a model."
      return Response.json({
        state: {
          ...state,
          messages: [
            { role: "user", text: prompt || "Hello" },
            { role: "assistant", text },
          ],
        },
        text,
      })
    }

    if (url.pathname.startsWith("/api/agent/demo/mcp/")) {
      return Response.json({ state, text: "MCP is added in Stage 02." })
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

function endpoints(origin: string) {
  return {
    state: `${origin}/api/agent/demo/state`,
    chat: `${origin}/api/agent/demo/chat`,
  }
}

async function readJson(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}
