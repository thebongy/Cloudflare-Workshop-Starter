import { FormEvent, ReactNode, useEffect, useRef, useState } from "react"

type Artifact =
  | { kind: "code"; title?: string; code?: string; language?: string }
  | { kind: "tools"; title?: string; calls?: ToolCall[] }
  | { kind: "json"; title?: string; data?: unknown }
  | { kind: "logs"; title?: string; lines?: string[] }

type ToolCall = {
  name: string
  input: unknown
  output?: unknown
  error?: string
}

type Message = {
  role: "user" | "assistant"
  text: string
  artifacts?: Artifact[]
}

type Snapshot = {
  stageLabel?: string
  state?: {
    messages?: Message[]
    selectedRepo?: string
    mcpConnection?: unknown
  }
}

const apiBase = "/api/agent/demo"
const starterPrompt = "Find stale open PRs with failing checks and suggest next actions."

export function WorkshopApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [snapshot, busy])

  const messages = snapshot?.state?.messages?.length
    ? snapshot.state.messages
    : [{ role: "assistant" as const, text: "Use the starter prompt to begin." }]
  const selectedRepo = snapshot?.state?.selectedRepo ?? "cloudflare/workers-sdk"

  async function load() {
    const next = await request("/state")
    if (next?.state && "mcpConnection" in next.state) await request("/mcp/connect", { method: "POST" })
  }

  async function request(path: string, init?: RequestInit) {
    setBusy(true)
    try {
      const response = await fetch(`${apiBase}${path}`, init)
      const payload = (await response.json()) as Snapshot | { error?: string }
      if (!response.ok) throw new Error("error" in payload ? payload.error : "Request failed")
      setSnapshot(payload as Snapshot)
      return payload as Snapshot
    } catch (error) {
      setSnapshot({
        state: {
          messages: [{ role: "assistant", text: error instanceof Error ? error.message : String(error) }],
        },
      })
      return null
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = prompt.trim()
    if (!text || busy) return
    setPrompt("")
    await request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: text, repo: selectedRepo }),
    })
  }

  return (
    <main className="chat-shell">
      <section className="turns" aria-live="polite">
        {messages.map((message, index) => (
          <article className={`turn ${message.role}`} key={index}>
            <div className="label">{message.role === "user" ? "You" : "Agent"}</div>
            <div className="bubble">{renderText(message.text)}</div>
            {message.artifacts?.map((artifact, artifactIndex) => (
              <ArtifactView artifact={artifact} key={artifactIndex} />
            ))}
          </article>
        ))}
        {busy && (
          <article className="turn assistant">
            <div className="label">Agent</div>
            <div className="bubble">Working...</div>
          </article>
        )}
        <div ref={endRef} />
      </section>

      <form className="composer" onSubmit={submit}>
        <button type="button" onClick={() => setPrompt(starterPrompt)} disabled={busy}>
          Starter
        </button>
        <textarea
          value={prompt}
          rows={2}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder="Ask the agent..."
        />
        <button type="submit" disabled={busy || !prompt.trim()}>
          Send
        </button>
      </form>
    </main>
  )
}

function ArtifactView({ artifact }: { artifact: Artifact }) {
  if (artifact.kind === "code") {
    return <Details title={artifact.title ?? "Generated code"}>{codeBlock(artifact.code ?? "", artifact.language ?? "js")}</Details>
  }

  if (artifact.kind === "tools") {
    return (
      <Details title={artifact.title ?? "Tool calls"}>
        {(artifact.calls ?? []).map((call, index) => (
          <details className="tool-call" key={index}>
            <summary>{call.name}</summary>
            {codeBlock({ input: call.input, output: call.output, error: call.error })}
          </details>
        ))}
      </Details>
    )
  }

  if (artifact.kind === "logs") {
    return <Details title={artifact.title ?? "Logs"}>{codeBlock((artifact.lines ?? []).join("\n"), "log")}</Details>
  }

  return <Details title={artifact.title ?? "Result"}>{codeBlock(artifact.data)}</Details>
}

function Details({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="artifact" open>
      <summary>{title}</summary>
      {children}
    </details>
  )
}

function renderText(text: string) {
  const parsed = parseJson(text)
  if (parsed !== undefined) return codeBlock(parsed)

  const chunks = text.split(/```(?:\w+)?\n?|```/g).filter(Boolean)
  if (chunks.length > 1) return chunks.map((chunk, index) => (index % 2 ? codeBlock(chunk.trim(), "text", index) : <p key={index}>{chunk.trim()}</p>))
  return <p>{text}</p>
}

function codeBlock(value: unknown, language = "json", key?: number) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return (
    <pre className="code" key={key}>
      <code data-language={language}>{text}</code>
    </pre>
  )
}

function parseJson(text: string) {
  if (!/^\s*[\[{]/.test(text)) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
