"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface HuntState {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  autoClaim: boolean;
  tweetBoostUrl: string | null;
  targetAgentIds: string[] | null;
  maxRunsPerDay: number;
  updatedAt: string;
  lastPollAt: string | null;
  lastPollStatus: "idle" | "ok" | "error";
  lastError: string | null;
  runsToday: number;
  totalRuns: number;
  totalCodesFound: number;
  totalCodesClaimed: number;
  totalNaraEarned: number;
  currentAgentId: string | null;
  nextPollAt: string | null;
}

interface Run {
  id: string;
  worker: string;
  agentId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  codesFound: number;
  codesClaimed: number;
  errors: number;
  note: string | null;
}

interface Props {
  initialState: HuntState | null;
  initialRuns: Run[];
  agents: any[];
}

export function AutomationClient({ initialState, initialRuns, agents }: Props) {
  const [state, setState] = useState<HuntState | null>(initialState);
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  const [enabled, setEnabled] = useState(initialState?.enabled ?? false);
  const [intervalSeconds, setIntervalSeconds] = useState(initialState?.intervalSeconds ?? 180);
  const [autoClaim, setAutoClaim] = useState(initialState?.autoClaim ?? true);
  const [tweetBoostUrl, setTweetBoostUrl] = useState(initialState?.tweetBoostUrl ?? "");
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(initialState?.maxRunsPerDay ?? 500);
  const [targetIds, setTargetIds] = useState<string[]>(initialState?.targetAgentIds ?? []);
  const [message, setMessage] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  const esRef = useRef<EventSource | null>(null);

  // SSE subscribe
  useEffect(() => {
    const es = new EventSource("/api/daemon/automation/hunt/stream");
    es.addEventListener("state", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as HuntState;
        setState(data);
      } catch {}
    });
    esRef.current = es;
    return () => es.close();
  }, []);

  // Poll runs table
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/daemon/automation/hunt/runs?limit=50");
        const data = await res.json();
        if (data.runs) setRuns(data.runs);
      } catch {}
    };
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // Tick for countdown
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const countdown = useMemo(() => {
    if (!state?.nextPollAt || !state.enabled) return null;
    const diff = new Date(state.nextPollAt).getTime() - nowTick;
    if (diff <= 0) return "now";
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }, [state?.nextPollAt, state?.enabled, nowTick]);

  async function save() {
    setMessage(null);
    try {
      const res = await fetch("/api/daemon/automation/hunt/configure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled,
          intervalSeconds,
          autoClaim,
          tweetBoostUrl: tweetBoostUrl.trim() || null,
          maxRunsPerDay,
          targetAgentIds: targetIds.length > 0 ? targetIds : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setState(data.state);
      setMessage("Saved ✓");
    } catch (err) {
      setMessage(`Error: ${(err as Error).message}`);
    }
  }

  async function runNow() {
    setMessage(null);
    try {
      const res = await fetch("/api/daemon/automation/hunt/run-now", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setState(data.state);
      setMessage(`Run: found=${data.codesFound} claimed=${data.codesClaimed} errors=${data.errors}`);
    } catch (err) {
      setMessage(`Error: ${(err as Error).message}`);
    }
  }

  function toggleAgent(id: string) {
    setTargetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const currentAgent = state?.currentAgentId ? agentMap.get(state.currentAgentId) : null;

  return (
    <>
      <section className="grid-cards">
        <div className="card">
          <div className="card-label">Worker</div>
          <div
            className="card-value"
            style={{
              fontSize: 16,
              color: state?.running
                ? "var(--info)"
                : state?.enabled
                  ? "var(--accent)"
                  : "var(--text-dim)",
            }}
          >
            {state?.running ? "POLLING" : state?.enabled ? "ARMED" : "OFF"}
          </div>
          <div className="card-trend">
            {state?.enabled ? (
              <>next poll in {countdown ?? "—"}</>
            ) : (
              <>enable to start</>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Total claimed</div>
          <div className="card-value" style={{ color: "var(--accent)" }}>
            {state?.totalCodesClaimed ?? 0}
          </div>
          <div className="card-trend">found: {state?.totalCodesFound ?? 0}</div>
        </div>
        <div className="card">
          <div className="card-label">Runs today</div>
          <div className="card-value">
            {state?.runsToday ?? 0}
            <span className="unit">/ {state?.maxRunsPerDay ?? "∞"}</span>
          </div>
          <div className="card-trend">total: {state?.totalRuns ?? 0}</div>
        </div>
        <div className="card">
          <div className="card-label">Last poll</div>
          <div className="card-value" style={{ fontSize: 12, wordBreak: "break-all" }}>
            {state?.lastPollAt ? new Date(state.lastPollAt).toLocaleTimeString() : "—"}
          </div>
          <div
            className="card-trend"
            style={{ color: state?.lastPollStatus === "error" ? "var(--danger)" : "var(--text-dim)" }}
          >
            status: {state?.lastPollStatus ?? "idle"}
          </div>
        </div>
      </section>

      {state?.running && currentAgent && (
        <div
          className="panel"
          style={{ borderColor: "var(--info)", background: "var(--accent-soft)" }}
        >
          <div className="row" style={{ gap: 8 }}>
            <span className="chip chip-live">● POLLING</span>
            <span>
              Checking agent: <strong style={{ color: "var(--accent)" }}>{currentAgent.agentId}</strong>
            </span>
          </div>
        </div>
      )}

      {state?.lastError && (
        <div className="panel" style={{ borderColor: "var(--danger)" }}>
          <div className="hint" style={{ color: "var(--danger)" }}>
            Last error: {state.lastError}
          </div>
        </div>
      )}

      <section className="panel">
        <div className="panel-header">
          <h2>Worker Config</h2>
          <span className="aux muted">changes apply instantly</span>
        </div>

        <div className="form-row">
          <label>Enabled</label>
          <div className="row">
            <label className="row" style={{ gap: 6, fontSize: 11 }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span className="muted">ON = poll dm-inbox every interval for all agents</span>
            </label>
          </div>
        </div>

        <div className="form-row">
          <label>Interval (seconds)</label>
          <input
            className="input"
            type="number"
            min="30"
            max="3600"
            value={intervalSeconds}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))}
          />
        </div>

        <div className="form-row">
          <label>Auto-claim</label>
          <div className="row">
            <label className="row" style={{ gap: 6, fontSize: 11 }}>
              <input type="checkbox" checked={autoClaim} onChange={(e) => setAutoClaim(e.target.checked)} />
              <span className="muted">claim every code found on-chain immediately</span>
            </label>
          </div>
        </div>

        <div className="form-row">
          <label>Tweet boost URL</label>
          <input
            className="input"
            placeholder="optional — https://x.com/you/status/... (applies to every claim for 2x)"
            value={tweetBoostUrl}
            onChange={(e) => setTweetBoostUrl(e.target.value)}
          />
        </div>

        <div className="form-row">
          <label>Max runs per day</label>
          <input
            className="input"
            type="number"
            min="1"
            max="10000"
            value={maxRunsPerDay}
            onChange={(e) => setMaxRunsPerDay(Number(e.target.value))}
          />
        </div>

        <div className="form-row" style={{ gridTemplateColumns: "160px 1fr", alignItems: "start" }}>
          <label>Target agents</label>
          <div>
            <div className="muted" style={{ fontSize: 10, marginBottom: 6 }}>
              leave empty = all eligible agents. check specific ones to limit scope.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {agents.map((a: any) => (
                <label
                  key={a.id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "4px 8px",
                    border: "1px solid var(--border-strong)",
                    borderRadius: 3,
                    fontSize: 10,
                    cursor: "pointer",
                    background: targetIds.includes(a.id) ? "var(--accent-soft)" : "transparent",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={targetIds.includes(a.id)}
                    onChange={() => toggleAgent(a.id)}
                  />
                  {a.agentId}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="toolbar" style={{ marginTop: 10 }}>
          <button className="btn btn-primary" onClick={save}>
            Save config
          </button>
          <button className="btn" onClick={runNow}>
            ▸ Run once now
          </button>
          {message && <span className="hint">{message}</span>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Run history</h2>
          <span className="aux muted">latest {runs.length} polls · auto-refresh 5s</span>
        </div>
        {runs.length === 0 ? (
          <div className="hint">No runs yet. Enable the worker or click Run once now.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Found</th>
                <th>Claimed</th>
                <th>Errors</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const agent = r.agentId ? agentMap.get(r.agentId) : null;
                return (
                  <tr key={r.id}>
                    <td className="muted" style={{ fontSize: 10 }}>
                      {new Date(r.startedAt).toLocaleTimeString()}
                    </td>
                    <td style={{ color: "var(--accent)", fontSize: 11 }}>
                      {agent?.agentId ?? (r.agentId ? r.agentId.slice(-8) : "—")}
                    </td>
                    <td>
                      <span
                        className={`badge badge-${
                          r.status === "ok" ? "running" : r.status === "error" ? "error" : "idle"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td>{r.codesFound}</td>
                    <td style={{ color: r.codesClaimed > 0 ? "var(--accent)" : "var(--text-dim)" }}>
                      {r.codesClaimed}
                    </td>
                    <td style={{ color: r.errors > 0 ? "var(--danger)" : "var(--text-dim)" }}>
                      {r.errors}
                    </td>
                    <td
                      className="muted"
                      style={{ fontSize: 10, maxWidth: 260, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                    >
                      {r.note ?? ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
