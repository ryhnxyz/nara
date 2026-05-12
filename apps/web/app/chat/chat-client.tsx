"use client";

import { useEffect, useRef, useState, useTransition } from "react";

interface Thread {
  threadId: string;
  agentId: string | null;
  lastAt: string;
  preview: string;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

interface Props {
  threads: Thread[];
  models: string[];
  agents: any[];
}

type Mode = "agent" | "chat";

export function ChatClient({ threads: initThreads, models, agents }: Props) {
  const [threads, setThreads] = useState(initThreads);
  const [activeThread, setActiveThread] = useState<string>(() => createThreadId());
  const [agentDbId, setAgentDbId] = useState<string>(agents[0]?.id ?? "");
  const [model, setModel] = useState<string>(models[0] ?? "kiro/claude-opus-4.7");
  const [mode, setMode] = useState<Mode>("agent");
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolCallLog, setToolCallLog] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadThread(activeThread);
  }, [activeThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadThread(id: string) {
    try {
      const res = await fetch(`/api/daemon/ai/threads/${id}`);
      const data = await res.json();
      setMessages(data.messages ?? []);
    } catch {
      setMessages([]);
    }
  }

  async function refreshThreads() {
    try {
      const res = await fetch("/api/daemon/ai/threads");
      const data = await res.json();
      setThreads(data.threads ?? []);
    } catch {}
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text) return;
    setError(null);
    setInput("");

    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    setToolCallLog([]);

    const endpoint = mode === "agent" ? "/api/daemon/ai/agent" : "/api/daemon/ai/chat";

    startTransition(async () => {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: activeThread,
            agentDbId: agentDbId || undefined,
            content: text,
            model,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        if (data.toolCalls) setToolCallLog(data.toolCalls);
        await loadThread(activeThread);
        await refreshThreads();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <div className="split" style={{ gridTemplateColumns: "240px 1fr" }}>
      <aside className="panel" style={{ padding: 12 }}>
        <div className="panel-header" style={{ marginBottom: 8, paddingBottom: 8 }}>
          <h2>Threads</h2>
        </div>
        <button
          className="btn btn-primary"
          style={{ width: "100%", marginBottom: 12 }}
          onClick={() => {
            const id = createThreadId();
            setActiveThread(id);
            setMessages([]);
            setToolCallLog([]);
          }}
        >
          + New chat
        </button>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {threads.length === 0 ? (
            <div className="hint">No threads yet.</div>
          ) : (
            threads.map((t) => (
              <button
                key={t.threadId}
                onClick={() => setActiveThread(t.threadId)}
                style={{
                  textAlign: "left",
                  background: activeThread === t.threadId ? "var(--accent-soft)" : "transparent",
                  border: "1px solid var(--border)",
                  borderLeft: activeThread === t.threadId ? "2px solid var(--accent)" : "2px solid transparent",
                  color: "var(--text)",
                  padding: "8px 10px",
                  borderRadius: 4,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                <div style={{ fontWeight: 700 }}>{t.threadId.slice(-10)}</div>
                <div className="muted" style={{ fontSize: 10, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.preview}
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <div className="panel" style={{ display: "flex", flexDirection: "column", height: "75vh" }}>
        <div className="panel-header">
          <h2>
            {mode === "agent" ? "Agent mode" : "Chat mode"} — {activeThread.slice(-10)}
          </h2>
          <div className="row" style={{ gap: 8 }}>
            <div style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: 4, overflow: "hidden" }}>
              <button
                onClick={() => setMode("agent")}
                style={{
                  padding: "6px 12px",
                  fontSize: 10,
                  letterSpacing: "0.18em",
                  fontWeight: 800,
                  background: mode === "agent" ? "var(--accent)" : "transparent",
                  color: mode === "agent" ? "#031607" : "var(--text-dim)",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                AGENT
              </button>
              <button
                onClick={() => setMode("chat")}
                style={{
                  padding: "6px 12px",
                  fontSize: 10,
                  letterSpacing: "0.18em",
                  fontWeight: 800,
                  background: mode === "chat" ? "var(--accent)" : "transparent",
                  color: mode === "chat" ? "#031607" : "var(--text-dim)",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                CHAT
              </button>
            </div>
            <select className="select" value={agentDbId} onChange={(e) => setAgentDbId(e.target.value)} style={{ width: 160 }}>
              <option value="">(no context)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.agentId}</option>
              ))}
            </select>
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)} style={{ width: 200 }}>
              {(models.length ? models : [model]).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {messages.length === 0 ? (
            <div className="hint" style={{ padding: 14 }}>
              {mode === "agent" ? (
                <>
                  <strong style={{ color: "var(--accent)" }}>Agent mode</strong> — AI has access to all bot tools and can execute actions autonomously.
                  Try: <em>“farm NARA for agent ryhn-nara-01”</em> or <em>“check dm inbox for all agents and claim any balls”</em>.
                </>
              ) : (
                <>Chat mode — plain Q&A without tools. Agent context is injected for better answers.</>
              )}
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} style={{ marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 9, letterSpacing: "0.22em", color: m.role === "user" ? "var(--info)" : "var(--accent)", marginBottom: 4 }}>
                  {m.role.toUpperCase()} · {new Date(m.createdAt).toLocaleTimeString()}
                </div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6 }}>{m.content}</div>
              </div>
            ))
          )}
          {toolCallLog.length > 0 && (
            <div style={{ padding: 10, background: "#05070a", border: "1px solid var(--border)", borderRadius: 4, marginBottom: 12 }}>
              <div style={{ fontSize: 9, letterSpacing: "0.22em", color: "var(--text-muted)", marginBottom: 6 }}>TOOL CALLS</div>
              {toolCallLog.map((tc, i) => (
                <div key={i} style={{ fontSize: 11, fontFamily: "var(--font-mono)", marginBottom: 4 }}>
                  <span style={{ color: tc.error ? "var(--danger)" : "var(--accent)" }}>
                    {tc.error ? "✗" : "✓"} {tc.name}
                  </span>
                  {" "}
                  <span className="muted" style={{ fontSize: 10 }}>({tc.durationMs ?? 0}ms)</span>
                </div>
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {error ? <div className="hint" style={{ color: "var(--danger)", marginBottom: 8 }}>{error}</div> : null}

        <form onSubmit={send} className="row" style={{ gap: 8, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={mode === "agent" ? "Tell the agent what to do…" : "Ask a question…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) send(e);
            }}
          />
          <button className="btn btn-primary" type="submit" disabled={pending || !input.trim()}>
            {pending ? "…" : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}

function createThreadId(): string {
  return `thr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
