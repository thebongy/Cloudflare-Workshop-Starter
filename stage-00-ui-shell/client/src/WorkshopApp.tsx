import { FormEvent, useEffect, useMemo, useRef, useState } from "react"

type JsonRecord = Record<string, unknown>
type Message = { role: "user" | "assistant"; text: string; createdAt?: string }
type Snapshot = {
  stage?: string
  stageLabel?: string
  model?: string
  state?: JsonRecord
}
type Turn = {
  id: string
  role: "user" | "assistant"
  label: string
  text: string
  code?: boolean
}

const basePath = "/api/agent/demo"
const defaultRepo = "cloudflare/workers-sdk"
const starterPrompt = "Find stale open PRs with failing checks and suggest next actions."

export function WorkshopApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadState()
    void request("/mcp/connect", { method: "POST" })
  }, [])

  const stageState = asRecord(snapshot?.state)
  const messages = Array.isArray(stageState?.messages) ? (stageState.messages as Message[]) : []
  const selectedRepo = typeof stageState?.selectedRepo === "string" ? stageState.selectedRepo : defaultRepo
  const run = asRecord(stageState?.lastRun)
  const generatedCode = typeof run?.generatedCode === "string" ? run.generatedCode.trim() : ""

  const turns = useMemo<Turn[]>(() => {
    const next: Turn[] = messages.map((message, index) => ({
      id: `${message.createdAt ?? index}-${message.role}`,
      role: message.role,
      label: message.role === "user" ? "You" : "Agent",
      text: message.text,
    }))

    if (generatedCode) {
      next.push({
        id: "last-generated-code",
        role: "assistant",
        label: "Code Mode",
        text: generatedCode,
        code: true,
      })
    }

    if (error) {
      next.push({
        id: "error",
        role: "assistant",
        label: "Agent",
        text: error,
      })
    }

    if (next.length === 0) {
      next.push({
        id: "empty",
        role: "assistant",
        label: "Agent",
        text: "Ask a question to start.",
      })
    }

    return next
  }, [error, generatedCode, messages])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [turns, busy])

  async function request(path: string, init?: RequestInit) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${basePath}${path}`, init)
      const payload = (await response.json()) as unknown
      if (!response.ok) throw new Error(errorText(payload))

      const nextSnapshot = normalizeSnapshot(payload)
      if (nextSnapshot) setSnapshot(nextSnapshot)
      return payload
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setBusy(false)
    }
  }

  async function loadState() {
    await request("/state")
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = prompt.trim()
    if (!trimmed || busy) return

    setPrompt("")
    await request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: trimmed, repo: selectedRepo }),
    })
  }

  return (
    <main className="chat-shell">
      <section className="turn-list" aria-live="polite">
        {turns.map((turn) => (
          <article key={turn.id} className={`turn ${turn.role}`}>
            <div className="turn-label">{turn.label}</div>
            {turn.code ? <pre>{turn.text}</pre> : <p>{turn.text}</p>}
          </article>
        ))}
        {busy ? (
          <article className="turn assistant">
            <div className="turn-label">Agent</div>
            <p>Working...</p>
          </article>
        ) : null}
        <div ref={endRef} />
      </section>

      <form className="composer" onSubmit={submit}>
        <button type="button" className="starter-prompt" onClick={() => setPrompt(starterPrompt)} disabled={busy}>
          Use starter prompt
        </button>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Ask the agent..."
          rows={1}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <button type="submit" disabled={busy || prompt.trim().length === 0}>
          {busy ? "..." : "Send"}
        </button>
      </form>
    </main>
  )
}

function normalizeSnapshot(payload: unknown): Snapshot | null {
  const record = asRecord(payload)
  if (!record) return null

  if (typeof record.stage === "string" && asRecord(record.state)) return record as Snapshot

  const nestedState = asRecord(record.state)
  if (nestedState) {
    if (typeof nestedState.stage === "string" && asRecord(nestedState.state)) return nestedState as Snapshot
    if (typeof nestedState.stageLabel === "string") {
      return {
        stage: typeof nestedState.stage === "string" ? nestedState.stage : undefined,
        stageLabel: String(nestedState.stageLabel),
        model: typeof nestedState.model === "string" ? nestedState.model : undefined,
        state: nestedState,
      }
    }
  }

  return null
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null
}

function errorText(payload: unknown) {
  const record = asRecord(payload)
  if (typeof record?.error === "string") return record.error
  if (typeof record?.text === "string") return record.text
  return "Request failed."
}
