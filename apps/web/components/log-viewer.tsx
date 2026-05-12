"use client";

import { useEffect, useRef, useState } from "react";

interface BotLog {
  id: string;
  agentId?: string | null;
  level: string;
  scope: string;
  message: string;
  createdAt: string;
  meta?: Record<string, unknown> | null;
}

interface Props {
  scopeFilter?: string;
  height?: number;
}

export function LogViewer({ scopeFilter, height = 520 }: Props) {
  const [logs, setLogs] = useState<BotLog[]>([]);
  const [connected, setConnected] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource("/api/daemon-stream");
    es.addEventListener("log", (ev: MessageEvent) => {
      try {
        const log = JSON.parse(ev.data) as BotLog;
        setLogs((prev) => {
          const next = [...prev, log];
          return next.slice(-500);
        });
      } catch {}
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const filtered = scopeFilter ? logs.filter((l) => l.scope.includes(scopeFilter)) : logs;

  return (
    <div>
      <div className="row" style={{ marginBottom: 8, fontSize: 10, letterSpacing: "0.18em", color: "var(--text-muted)" }}>
        <span className={connected ? "chip chip-live" : "badge badge-idle"}>
          {connected ? "● STREAM LIVE" : "○ DISCONNECTED"}
        </span>
        <span>{filtered.length} entries {scopeFilter ? `(scope: ${scopeFilter})` : ""}</span>
      </div>
      <div className="log-stream" ref={containerRef} style={{ maxHeight: height }}>
        {filtered.length === 0 ? (
          <div className="hint">Waiting for log events…</div>
        ) : (
          filtered.map((l) => (
            <div key={l.id} className={`log-line lvl-${l.level}`}>
              <span className="time">{new Date(l.createdAt).toLocaleTimeString()}</span>
              <span className="lvl">{l.level}</span>
              <span className="scope">{l.scope}</span>
              <span className="msg">{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
