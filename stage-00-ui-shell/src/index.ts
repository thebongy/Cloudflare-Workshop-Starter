type Message = {
  role: "user" | "assistant"
  text: string
  createdAt: string
}

const state = {
  messages: [] as Message[],
  selectedRepo: "cloudflare/workers-sdk",
}

interface Env {
  ASSETS: Fetcher
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === "/api/agent/demo/state") {
      return Response.json(snapshot())
    }

    if (url.pathname === "/api/agent/demo/chat" && request.method === "POST") {
      const { prompt } = await request.json<{ prompt?: string }>()
      state.messages.push(message("user", prompt ?? "Hello"))
      state.messages.push(message("assistant", "Stage 00 is just the Worker and React UI shell."))
      return Response.json(snapshot())
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

function snapshot() {
  return {
    stage: "stage-00-ui-shell",
    stageLabel: "Worker + UI shell",
    state,
  }
}

function message(role: Message["role"], text: string): Message {
  return { role, text, createdAt: new Date().toISOString() }
}
