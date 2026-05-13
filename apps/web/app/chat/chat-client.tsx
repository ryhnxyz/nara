"use client";

import { useEffect, useRef, useState } from "react";

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

interface ToolCallLive {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  result?: unknown;
  error?: string;
  durationMs?: number;
}

type Mode = "agent" | "chat";

export function ChatClient({ threads: initThreads, models, agents }: Props) {
  const [threads, setThreads] = useState(initThreads);
  const [activeThread, setActiveThread] = useState<string>(() => createThreadId());
  const [agentDbId, setAgentDbId] = useState<string>(agents[0]?.id ?? "");
  const FIXED_MODEL = "kiro/claude-opus-4.7";
  const [mode, setMode] = useState<Mode>("agent");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamText, setStreamText] = useState("");
  const [toolCalls, setToolCalls] = useState<ToolCallLive[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadThread(activeThread);
  }, [activeThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText, toolCalls]);

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

  function updateToolCall(id: string, patch: Partial<ToolCallLive>) {
    setToolCalls((prev) => prev.map((tc) => (tc.id === id ? { ...tc, ...patch } : tc)));
  }

  async function streamAgent(text: string) {
    setStreaming(true);
    setError(null);
    setStreamText("");
    setToolCalls([]);

    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/daemon/ai/agent/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: activeThread,
          agentDbId: agentDbId || undefined,
          content: text,
          model: FIXED_MODEL,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(errText.slice(0, 300));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let eventType = "message";
          let dataLine = "";
          for (const raw of block.split("\n")) {
            const line = raw.trim();
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          let payload: any;
          try {
            payload = JSON.parse(dataLine);
          } catch {
            continue;
          }

          switch (eventType) {
            case "text-delta":
              setStreamText((t) => t + (payload.delta ?? ""));
              break;
            case "tool-call-start":
              setToolCalls((prev) => [
                ...prev,
                { id: payload.id, name: payload.name, args: payload.args ?? {}, status: "running" },
              ]);
              break;
            case "tool-call-result":
              updateToolCall(payload.id, {
                status: payload.ok ? "ok" : "error",
                result: payload.result,
                error: payload.error,
                durationMs: payload.durationMs,
              });
              break;
            case "step-end":
              // no-op, just informational
              break;
            case "done":
              await refreshThreads();
              await loadThread(activeThread);
              setStreamText("");
              break;
            case "error":
              throw new Error(payload.message ?? "stream error");
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  async function sendChatMode(text: string) {
    setError(null);
    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    try {
      const res = await fetch("/api/daemon/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: activeThread,
          agentDbId: agentDbId || undefined,
          content: text,
          model: FIXED_MODEL,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      await loadThread(activeThread);
      await refreshThreads();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    if (mode === "agent") await streamAgent(text);
    else await sendChatMode(text);
  }

  function stopStream() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  return (
    <div className="split" style={{ gridTemplateColumns: "240px 1fr" }}>
      <aside className="panel" style={{ padding: 12 }}>
        <div className="panel-header" style={{ marginBottom: 8, paddingBottom: 8 }}>
          <h2>Threads</h2>
        </div>
        <button
          className="btn btn-primary"
          style={{ width: "100%", marginBottom: 6 }}
          onClick={() => {
            const id = createThreadId();
            setActiveThread(id);
            setMessages([]);
            setToolCalls([]);
            setStreamText("");
          }}
        >
          + New chat
        </button>
        {threads.length > 0 && (
          <button
            className="btn btn-danger"
            style={{ width: "100%", marginBottom: 12, fontSize: 10 }}
            onClick={async () => {
              if (!confirm(`Delete ALL ${threads.length} threads? This cannot be undone.`)) return;
              await fetch("/api/daemon/ai/threads", { method: "DELETE" });
              await refreshThreads();
              const id = createThreadId();
              setActiveThread(id);
              setMessages([]);
              setToolCalls([]);
              setStreamText("");
            }}
          >
            Clear all ({threads.length})
          </button>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {threads.length === 0 ? (
            <div className="hint">No threads yet.</div>
          ) : (
            threads.map((t) => (
              <div
                key={t.threadId}
                style={{
                  display: "flex",
                  alignItems: "stretch",
                  gap: 4,
                  background: activeThread === t.threadId ? "var(--accent-soft)" : "transparent",
                  border: "1px solid var(--border)",
                  borderLeft: activeThread === t.threadId ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRadius: 4,
                }}
              >
                <button
                  onClick={() => setActiveThread(t.threadId)}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: "var(--text)",
                    padding: "8px 10px",
                    fontSize: 11,
                    cursor: "pointer",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{t.threadId.slice(-10)}</div>
                  <div
                    className="muted"
                    style={{ fontSize: 10, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {t.preview}
                  </div>
                </button>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete thread ${t.threadId.slice(-10)}?`)) return;
                    await fetch(`/api/daemon/ai/threads/${t.threadId}`, { method: "DELETE" });
                    await refreshThreads();
                    if (activeThread === t.threadId) {
                      const id = createThreadId();
                      setActiveThread(id);
                      setMessages([]);
                      setToolCalls([]);
                      setStreamText("");
                    }
                  }}
                  title="Delete thread"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    padding: "0 8px",
                    fontSize: 14,
                    borderLeft: "1px solid var(--border)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      <div className="panel" style={{ display: "flex", flexDirection: "column", height: "80vh" }}>
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
            <select
              className="select"
              value={agentDbId}
              onChange={(e) => setAgentDbId(e.target.value)}
              style={{ width: 160 }}
            >
              <option value="">(no context)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.agentId}
                </option>
              ))}
            </select>
            <span
              style={{
                fontSize: 10,
                letterSpacing: "0.12em",
                color: "var(--accent)",
                padding: "4px 10px",
                border: "1px solid var(--accent-dim)",
                borderRadius: 4,
                background: "var(--accent-soft)",
                fontFamily: "var(--font-mono)",
              }}
              title="Model is locked"
            >
              ◆ kiro/claude-opus-4.7
            </span>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {messages.length === 0 && !streamText && toolCalls.length === 0 ? (
            <div className="hint" style={{ padding: 14 }}>
              {mode === "agent" ? (
                <>
                  <strong style={{ color: "var(--accent)" }}>Agent mode (streaming)</strong> — AI has access to all bot tools. Try:{" "}
                  <em>"farm NARA for agent ryhn-nara-01"</em> or{" "}
                  <em>"check dm inbox for all agents and claim any balls"</em>.
                </>
              ) : (
                <>Chat mode — plain Q&A without tools. Agent context is injected for better answers.</>
              )}
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                style={{ marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}
              >
                <div
                  style={{
                    fontSize: 9,
                    letterSpacing: "0.22em",
                    color: m.role === "user" ? "var(--info)" : "var(--accent)",
                    marginBottom: 4,
                  }}
                >
                  {m.role.toUpperCase()} · {new Date(m.createdAt).toLocaleTimeString()}
                </div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6 }}>{m.content}</div>
              </div>
            ))
          )}

          {toolCalls.length > 0 && (
            <div
              style={{
                padding: 10,
                background: "#05070a",
                border: "1px solid var(--border)",
                borderRadius: 4,
                marginBottom: 12,
              }}
            >
              <div style={{ fontSize: 9, letterSpacing: "0.22em", color: "var(--text-muted)", marginBottom: 6 }}>
                TOOL CALLS ({toolCalls.length})
              </div>
              {toolCalls.map((tc) => (
                <div
                  key={tc.id}
                  style={{ fontSize: 11, fontFamily: "var(--font-mono)", marginBottom: 6, paddingBottom: 6, borderBottom: "1px dashed var(--border)" }}
                >
                  <div>
                    <span
                      style={{
                        color:
                          tc.status === "running"
                            ? "var(--info)"
                            : tc.status === "ok"
                              ? "var(--accent)"
                              : "var(--danger)",
                      }}
                    >
                      {tc.status === "running" ? "◌" : tc.status === "ok" ? "✓" : "✗"} {tc.name}
                    </span>
                    {tc.durationMs !== undefined ? (
                      <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>
                        ({tc.durationMs}ms)
                      </span>
                    ) : null}
                  </div>
                  {Object.keys(tc.args).length > 0 && (
                    <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
                      args: {JSON.stringify(tc.args).slice(0, 120)}
                    </div>
                  )}
                  {tc.error && (
                    <div style={{ fontSize: 10, color: "var(--danger)", marginTop: 2 }}>
                      error: {tc.error.slice(0, 200)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {streamText && (
            <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
              <div
                style={{
                  fontSize: 9,
                  letterSpacing: "0.22em",
                  color: "var(--accent)",
                  marginBottom: 4,
                }}
              >
                ASSISTANT · streaming…
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6 }}>
                {streamText}
                <span style={{ opacity: 0.5 }}>▊</span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {error ? (
          <div className="hint" style={{ color: "var(--danger)", marginBottom: 8 }}>
            {error}
          </div>
        ) : null}

        <form
          onSubmit={send}
          className="row"
          style={{ gap: 8, borderTop: "1px solid var(--border)", paddingTop: 12 }}
        >
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={mode === "agent" ? "Tell the agent what to do…" : "Ask a question…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={streaming}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) send(e);
            }}
          />
          {streaming ? (
            <button type="button" className="btn btn-danger" onClick={stopStream}>
              ■ Stop
            </button>
          ) : (
            <button className="btn btn-primary" type="submit" disabled={!input.trim()}>
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function createThreadId(): string {
  return `thr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
