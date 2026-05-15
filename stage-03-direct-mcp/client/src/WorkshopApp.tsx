import { Badge, Button, InputArea, LayerCard } from "@cloudflare/kumo"
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

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
  const [isGenerating, setIsGenerating] = useState(false)
  const [optimisticMessages, setOptimisticMessages] = useState<Message[]>([])
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [snapshot, optimisticMessages, isGenerating])

  const savedMessages = snapshot?.state?.messages?.length
    ? snapshot.state.messages
    : [{ role: "assistant" as const, text: "Use the starter prompt to begin." }]
  const messages = optimisticMessages.length ? [...savedMessages, ...optimisticMessages] : savedMessages
  const selectedRepo = snapshot?.state?.selectedRepo ?? "cloudflare/workers-sdk"

  async function load() {
    const next = await request("/state")
    if (next?.state && "mcpConnection" in next.state) await request("/mcp/connect", { method: "POST" })
  }

  async function request(path: string, init?: RequestInit, fallbackMessages: Message[] = []) {
    setBusy(true)
    try {
      const response = await fetch(`${apiBase}${path}`, init)
      const payload = (await response.json()) as Snapshot | { error?: string }
      if (!response.ok) throw new Error("error" in payload ? payload.error : "Request failed")
      setSnapshot(payload as Snapshot)
      return payload as Snapshot
    } catch (error) {
      setSnapshot((current) => {
        const currentMessages = current?.state?.messages?.length ? current.state.messages : []
        return {
          ...current,
          state: {
            ...current?.state,
            messages: [...currentMessages, ...fallbackMessages, { role: "assistant", text: error instanceof Error ? error.message : String(error) }],
          },
        }
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
    const optimisticMessage: Message = { role: "user", text }
    setOptimisticMessages([optimisticMessage])
    setIsGenerating(true)
    setPrompt("")
    try {
      await request(
        "/chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: text, repo: selectedRepo }),
        },
        [optimisticMessage],
      )
    } finally {
      setOptimisticMessages([])
      setIsGenerating(false)
    }
  }

  return (
    <main className="chat-shell">
      <section className="agent-frame" aria-label="Github MCP Agent">
        <header className="app-header">
          <div>
            <Badge variant="orange">{snapshot?.stageLabel ?? "Workshop"}</Badge>
            <h1>Github MCP Agent</h1>
          </div>
          <Badge variant="outline">{selectedRepo}</Badge>
        </header>

        <LayerCard className="chat-card">
          <section className="turns" aria-live="polite">
            {messages.map((message, index) => (
              <article className={`turn ${message.role}`} key={index}>
                <Badge variant={message.role === "user" ? "orange" : "secondary"}>{message.role === "user" ? "You" : "Agent"}</Badge>
                <div className="bubble">{renderText(message.text)}</div>
                {message.artifacts?.map((artifact, artifactIndex) => (
                  <ArtifactView artifact={artifact} key={artifactIndex} />
                ))}
              </article>
            ))}
            {isGenerating && (
              <article className="turn assistant pending">
                <Badge variant="secondary">Agent</Badge>
                <div className="bubble generating-bubble">
                  <p className="generating-text">Generating...</p>
                </div>
              </article>
            )}
            <div ref={endRef} />
          </section>

          <form className="composer" onSubmit={submit}>
            <Button type="button" variant="secondary" onClick={() => setPrompt(starterPrompt)} disabled={busy}>
              Starter
            </Button>
            <InputArea
              aria-label="Ask the agent"
              className="prompt-input"
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
            <Button type="submit" variant="primary" disabled={busy || !prompt.trim()}>
              Send
            </Button>
          </form>
        </LayerCard>
      </section>
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

  return <MarkdownText text={text} />
}

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return <>{children}</>
          },
          code({ className, children, ...props }) {
            const language = /language-(\w+)/.exec(className ?? "")?.[1]
            const value = String(children).replace(/\n$/, "")
            if (language) return codeBlock(value, language)
            return (
              <code className="inline-code" {...props}>
                {children}
              </code>
            )
          },
          a({ children, ...props }) {
            return (
              <a {...props} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
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
