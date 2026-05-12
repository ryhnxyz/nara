"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Agent {
  id: string;
  agentId: string;
  displayName: string;
  status: string;
  walletAddress: string | null;
  walletPath: string | null;
  twitterBound: boolean;
  staked: boolean;
  firstPostDone: boolean;
  totalEarned: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  activeFlow: boolean;
  lastRun?: any;
}

interface Props {
  initialAgents: Agent[];
}

export function AgentList({ initialAgents }: Props) {
  const router = useRouter();
  const [agents, setAgents] = useState(initialAgents);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/daemon/agents");
        const data = await res.json();
        if (data.agents) setAgents(data.agents);
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, []);

  async function call(path: string, body?: any, method: string = "POST") {
    setMessage(null);
    try {
      const res = await fetch(`/api/daemon${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setMessage(`OK: ${path}`);
      router.refresh();
      return data;
    } catch (err) {
      setMessage(`Error: ${(err as Error).message}`);
    }
  }

  async function runFlow(agent: Agent) {
    const bind = window.prompt(
      "Bind tweet URL (any valid X post works — Enter for default placeholder):",
      "https://x.com/NESAM_SM/status/2053769643647799499"
    );
    if (bind === null) return;
    startTransition(() =>
      call(`/agents/${agent.id}/run`, {
        bindTweetUrl: bind || undefined,
        tweetBoostAfterClaim: true,
      })
    );
  }

  if (agents.length === 0) {
    return (
      <section className="panel">
        <div className="hint">No agents yet. Add one above.</div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Registered agents</h2>
        <span className="aux muted">{agents.length} · auto-refresh 4s</span>
      </div>

      {message ? <div className="hint" style={{ marginBottom: 10 }}>{message}</div> : null}

      <table className="table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Status</th>
            <th>Wallet</th>
            <th>X</th>
            <th>Stake</th>
            <th>Earned</th>
            <th>Last run</th>
            <th style={{ width: 240 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <>
              <tr key={a.id}>
                <td>
                  <div style={{ color: "var(--accent)", fontWeight: 700 }}>{a.agentId}</div>
                  <div className="muted" style={{ fontSize: 10 }}>{a.displayName}</div>
                </td>
                <td>
                  <span className={`badge badge-${a.activeFlow ? "running" : a.status}`}>
                    {a.activeFlow ? "flow" : a.status}
                  </span>
                </td>
                <td className="muted" style={{ fontSize: 10, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {a.walletAddress ?? "—"}
                </td>
                <td>
                  <span className={`badge badge-${a.twitterBound ? "ok" : "idle"}`}>
                    {a.twitterBound ? "bound" : "no"}
                  </span>
                </td>
                <td>
                  <span className={`badge badge-${a.staked ? "ok" : "idle"}`}>
                    {a.staked ? "yes" : "no"}
                  </span>
                </td>
                <td>{Number(a.totalEarned ?? 0).toFixed(2)}</td>
                <td className="muted" style={{ fontSize: 10 }}>
                  {a.lastRunAt ? `${new Date(a.lastRunAt).toLocaleTimeString()} ${a.lastRunStatus ?? ""}` : "—"}
                </td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      className="btn btn-primary"
                      disabled={pending || a.activeFlow}
                      onClick={() => runFlow(a)}
                    >
                      {a.activeFlow ? "running…" : "▸ run flow"}
                    </button>
                    {a.activeFlow ? (
                      <button
                        className="btn btn-danger"
                        onClick={() => startTransition(() => call(`/agents/${a.id}/cancel`))}
                      >
                        cancel
                      </button>
                    ) : null}
                    <button
                      className="btn"
                      onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                    >
                      {expanded === a.id ? "hide" : "steps"}
                    </button>
                  </div>
                </td>
              </tr>
              {expanded === a.id ? (
                <tr key={a.id + "-detail"}>
                  <td colSpan={8} style={{ background: "#05070a", padding: 12 }}>
                    <StepList run={a.lastRun} />
                  </td>
                </tr>
              ) : null}
            </>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function StepList({ run }: { run: any }) {
  if (!run || !run.steps?.length) return <div className="hint">No flow run yet.</div>;
  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: "0.2em", color: "var(--text-muted)", marginBottom: 6 }}>
        RUN {run.id.slice(-8)} · {run.status}
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
        {run.steps.map((s: any, i: number) => (
          <li key={i}>
            <span style={{ color: stepColor(s.status) }}>{s.status.toUpperCase()}</span>{" "}
            <strong>{s.step}</strong>
            {s.message ? <span className="muted"> — {s.message}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function stepColor(status: string): string {
  switch (status) {
    case "success": return "var(--accent)";
    case "running": return "var(--info)";
    case "error": return "var(--danger)";
    case "skipped": return "var(--text-muted)";
    default: return "var(--text-dim)";
  }
}
