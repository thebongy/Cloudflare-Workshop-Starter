import { FormEvent, useEffect, useMemo, useRef, useState } from "react"

type JsonRecord = Record<string, unknown>
type MessageArtifact = {
  kind?: string
  title?: string
  language?: string
  code?: string
  text?: string
  data?: unknown
  lines?: string[]
  calls?: ToolTrace[]
}
type ToolTrace = {
  name?: string
  input?: unknown
  output?: unknown
  error?: string
  startedAt?: string
  completedAt?: string
}
type Message = {
  role: "user" | "assistant"
  text: string
  createdAt?: string
  artifacts?: MessageArtifact[]
}
type Snapshot = {
  stage?: string
  stageLabel?: string
  model?: string
  state?: JsonRecord
}
type RenderMessage = Message & {
  id: string
  label: string
  artifacts: MessageArtifact[]
}
type TextChunk = { type: "text"; value: string } | { type: "code"; value: string; language: string }
type Token = { value: string; className?: string }

const basePath = "/api/agent/demo"
const defaultRepo = "cloudflare/workers-sdk"
const starterPrompt = "Find stale open PRs with failing checks and suggest next actions."

export function WorkshopApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingRequests = useRef(0)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadState()
    void request("/mcp/connect", { method: "POST" })
  }, [])

  const stageState = asRecord(snapshot?.state)
  const rawMessages = Array.isArray(stageState?.messages) ? (stageState.messages as Message[]) : []
  const selectedRepo = typeof stageState?.selectedRepo === "string" ? stageState.selectedRepo : defaultRepo
  const run = asRecord(stageState?.lastRun)

  const messages = useMemo<RenderMessage[]>(() => {
    const next = rawMessages.map((message, index) => ({
      ...message,
      id: `${message.createdAt ?? index}-${message.role}`,
      label: message.role === "user" ? "You" : "Agent",
      artifacts: Array.isArray(message.artifacts) ? message.artifacts : [],
    }))

    const latestAssistantIndex = findLastAssistantIndex(next)
    if (run && latestAssistantIndex >= 0 && next[latestAssistantIndex].artifacts.length === 0) {
      next[latestAssistantIndex] = {
        ...next[latestAssistantIndex],
        artifacts: artifactsFromRun(run),
      }
    }

    if (error) {
      next.push({
        id: "error",
        role: "assistant",
        label: "Agent",
        text: error,
        artifacts: [],
      })
    }

    if (next.length === 0) {
      next.push({
        id: "empty",
        role: "assistant",
        label: "Agent",
        text: "Ask a question to start.",
        artifacts: [],
      })
    }

    return next
  }, [error, rawMessages, run])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [messages, busy])

  async function request(path: string, init?: RequestInit) {
    pendingRequests.current += 1
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
      pendingRequests.current = Math.max(0, pendingRequests.current - 1)
      if (pendingRequests.current === 0) setBusy(false)
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
        {messages.map((message) => (
          <article key={message.id} className={`turn ${message.role}`}>
            <div className="turn-label">{message.label}</div>
            <div className="turn-content">{renderMessageText(message.text, message.role)}</div>
            {message.artifacts.length > 0 ? (
              <div className="artifact-list">
                {message.artifacts.map((artifact, index) => (
                  <ArtifactBlock artifact={artifact} key={`${message.id}-artifact-${index}`} />
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {busy ? (
          <article className="turn assistant">
            <div className="turn-label">Agent</div>
            <div className="turn-content">
              <p>Working...</p>
            </div>
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

function renderMessageText(text: string, role: Message["role"]) {
  const trimmed = text.trim()
  const parsed = role === "assistant" ? tryParseJson(trimmed) : undefined
  if (parsed !== undefined) {
    return <CodeBlock code={formatJson(parsed)} language="json" />
  }

  const chunks = splitFencedCode(text)
  return chunks.map((chunk, index) => {
    if (chunk.type === "code") return <CodeBlock code={chunk.value} language={chunk.language} key={index} />
    return chunk.value.trim() ? <p key={index}>{chunk.value}</p> : null
  })
}

function ArtifactBlock({ artifact }: { artifact: MessageArtifact }) {
  const kind = artifact.kind ?? "text"
  const title = artifact.title ?? artifactTitle(kind)

  if (kind === "tools") {
    const calls = Array.isArray(artifact.calls) ? artifact.calls : []
    return (
      <details className="artifact" open>
        <summary>{title}</summary>
        <div className="tool-call-list">
          {calls.length === 0 ? <p className="empty-artifact">No tool calls recorded.</p> : null}
          {calls.map((call, index) => (
            <details className="tool-call" key={`${call.name ?? "tool"}-${index}`}>
              <summary>
                <span>{call.name ?? "tool"}</span>
                {call.error ? <span className="error-pill">error</span> : null}
              </summary>
              <ArtifactJson label="Input" value={call.input} />
              {call.output !== undefined ? <ArtifactJson label="Output" value={call.output} /> : null}
              {call.error ? <ArtifactJson label="Error" value={call.error} /> : null}
            </details>
          ))}
        </div>
      </details>
    )
  }

  if (kind === "logs") {
    const lines = Array.isArray(artifact.lines) ? artifact.lines : []
    return (
      <details className="artifact">
        <summary>{title}</summary>
        <CodeBlock code={lines.join("\n") || "No logs recorded."} language="log" />
      </details>
    )
  }

  if (kind === "json") {
    const value = artifact.data ?? artifact.text ?? null
    return (
      <details className="artifact">
        <summary>{title}</summary>
        <CodeBlock code={typeof value === "string" ? formatMaybeJson(value) : formatJson(value)} language="json" />
      </details>
    )
  }

  if (kind === "code") {
    const code = artifact.code ?? artifact.text ?? ""
    return (
      <details className="artifact" open>
        <summary>{title}</summary>
        <CodeBlock code={code || "No code captured."} language={artifact.language ?? "js"} />
      </details>
    )
  }

  return (
    <details className="artifact">
      <summary>{title}</summary>
      <p>{artifact.text ?? formatJson(artifact.data ?? artifact)}</p>
    </details>
  )
}

function ArtifactJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="artifact-json">
      <div className="artifact-json-label">{label}</div>
      <CodeBlock code={formatJson(value)} language="json" />
    </div>
  )
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const tokens = tokenize(code, language)
  return (
    <pre className={`code-block language-${language}`}>
      <code>
        {tokens.map((token, index) =>
          token.className ? (
            <span className={token.className} key={index}>
              {token.value}
            </span>
          ) : (
            <span key={index}>{token.value}</span>
          ),
        )}
      </code>
    </pre>
  )
}

function splitFencedCode(text: string): TextChunk[] {
  const chunks: TextChunk[] = []
  const pattern = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) chunks.push({ type: "text", value: text.slice(lastIndex, match.index) })
    chunks.push({ type: "code", language: match[1] || "text", value: match[2].trim() })
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) chunks.push({ type: "text", value: text.slice(lastIndex) })
  return chunks.length > 0 ? chunks : [{ type: "text", value: text }]
}

function tokenize(code: string, language: string): Token[] {
  const tokens: Token[] = []
  const keywords =
    language === "json"
      ? /^(true|false|null)$/
      : /^(async|await|break|case|catch|const|continue|default|else|export|for|from|function|if|import|in|let|new|null|return|throw|try|undefined|while)$/
  const pattern =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b|[{}()[\].,;:+\-*/=<>&|!?]+)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(code)) !== null) {
    if (match.index > lastIndex) tokens.push({ value: code.slice(lastIndex, match.index) })
    const value = match[0]
    tokens.push({ value, className: tokenClass(value, keywords, language) })
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < code.length) tokens.push({ value: code.slice(lastIndex) })
  return tokens
}

function tokenClass(value: string, keywords: RegExp, language: string) {
  if (value.startsWith("//") || value.startsWith("/*")) return "tok-comment"
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith("`")) {
    return language === "json" && value.endsWith('"') ? "tok-json-string" : "tok-string"
  }
  if (/^\d/.test(value)) return "tok-number"
  if (keywords.test(value)) return "tok-keyword"
  if (/^[{}()[\].,;:+\-*/=<>&|!?]+$/.test(value)) return "tok-punctuation"
  return undefined
}

function artifactsFromRun(run: JsonRecord): MessageArtifact[] {
  const artifacts: MessageArtifact[] = []
  const generatedCode = typeof run.generatedCode === "string" ? run.generatedCode.trim() : ""
  const logs = Array.isArray(run.logs) ? run.logs.filter((entry): entry is string => typeof entry === "string") : []
  const calls = Array.isArray(run.mcpCalls) ? (run.mcpCalls as ToolTrace[]) : []

  if (generatedCode) artifacts.push({ kind: "code", title: "Generated Code", language: "js", code: generatedCode })
  if (calls.length > 0) artifacts.push({ kind: "tools", title: "GitHub MCP Calls", calls })
  if (run.result !== undefined && !sameText(run.result, run.finalText)) artifacts.push({ kind: "json", title: "Result", data: run.result })
  if (logs.length > 0) artifacts.push({ kind: "logs", title: "Agent Loop", lines: logs })

  return artifacts
}

function findLastAssistantIndex(messages: RenderMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return index
  }
  return -1
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

function artifactTitle(kind: string) {
  if (kind === "code") return "Generated Code"
  if (kind === "json") return "Result"
  if (kind === "logs") return "Agent Loop"
  if (kind === "tools") return "Tool Calls"
  return "Details"
}

function formatMaybeJson(text: string) {
  const parsed = tryParseJson(text)
  return parsed === undefined ? text : formatJson(parsed)
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function tryParseJson(text: string) {
  if (!text || !/^[\[{]/.test(text)) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function sameText(value: unknown, text: unknown) {
  if (typeof text !== "string") return false
  if (typeof value === "string") return value.trim() === text.trim()
  return formatJson(value).trim() === text.trim()
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
