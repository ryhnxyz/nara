import { daemon } from "@/lib/daemon";

export const dynamic = "force-dynamic";

async function loadData() {
  try {
    const [agentsRes, logsRes, claimsRes, modelsRes] = await Promise.all([
      daemon.listAgents(),
      daemon.recentLogs(60),
      daemon.dragonBallClaims(),
      daemon.aiModels().catch(() => ({ configured: false, default: null, baseUrl: null })),
    ]);
    return {
      agents: agentsRes.agents,
      logs: logsRes.logs,
      claims: claimsRes.claims,
      ai: modelsRes,
      error: null as string | null,
    };
  } catch (err) {
    return { agents: [], logs: [], claims: [], ai: null, error: (err as Error).message };
  }
}

export default async function OverviewPage() {
  const { agents, logs, claims, ai, error } = await loadData();
  const running = agents.filter((a: any) => a.activeFlow || a.status === "running").length;
  const bound = agents.filter((a: any) => a.twitterBound).length;
  const staked = agents.filter((a: any) => a.staked).length;
  const totalEarned = agents.reduce((sum: number, a: any) => sum + Number(a.totalEarned ?? 0), 0);
  const claimed = claims.filter((c: any) => c.status === "claimed" || c.status === "boosted").length;

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="kicker">Control Center</div>
          <h1>Overview</h1>
          <div className="page-subtitle">
            Run the full Nara flow per agent: wallet → fund → register → bind → stake → submit → claim.
          </div>
        </div>
        <div className="row">
          <span className="chip chip-live">● LIVE</span>
          <a className="btn btn-primary" href="/agents">Manage agents</a>
        </div>
      </header>

      {error ? (
        <div className="panel" style={{ borderColor: "var(--danger)" }}>
          <div className="panel-header">
            <h2 style={{ color: "var(--danger)" }}>Daemon offline</h2>
            <span className="aux muted">start with: pnpm daemon</span>
          </div>
          <div className="hint">
            Cannot reach {daemon.url}. {error}
          </div>
        </div>
      ) : null}

      <section className="grid-cards">
        <div className="card">
          <div className="card-label">Agents</div>
          <div className="card-value">{agents.length}<span className="unit">total</span></div>
          <div className="card-trend">{running} running · {bound} bound · {staked} staked</div>
        </div>
        <div className="card">
          <div className="card-label">Dragon Balls</div>
          <div className="card-value" style={{ color: "var(--accent)" }}>{claimed}<span className="unit">/ {claims.length}</span></div>
          <div className="card-trend">claimed / discovered</div>
        </div>
        <div className="card">
          <div className="card-label">AI Provider</div>
          <div className="card-value" style={{ fontSize: 14, color: ai?.configured ? "var(--accent)" : "var(--danger)" }}>
            {ai?.configured ? "READY" : "MISSING"}
          </div>
          <div className="card-trend">model: {ai?.default ?? "—"}</div>
        </div>
        <div className="card">
          <div className="card-label">Total Earned</div>
          <div className="card-value">{totalEarned.toFixed(2)}<span className="unit">NARA</span></div>
          <div className="card-trend">local tracking</div>
        </div>
      </section>

      <section className="split">
        <div className="panel">
          <div className="panel-header">
            <h2>Agents</h2>
            <a className="aux" href="/agents">manage →</a>
          </div>
          {agents.length === 0 ? (
            <div className="hint">No agents yet. Go to Agents → register one (wallet auto-generated on first run).</div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Agent</th><th>Status</th><th>X</th><th>Stake</th><th>Last</th></tr>
              </thead>
              <tbody>
                {agents.slice(0, 6).map((a: any) => (
                  <tr key={a.id}>
                    <td style={{ color: "var(--accent)" }}>{a.agentId}</td>
                    <td>
                      <span className={`badge badge-${a.activeFlow ? "running" : a.status}`}>
                        {a.activeFlow ? "flow" : a.status}
                      </span>
                    </td>
                    <td><span className={`badge badge-${a.twitterBound ? "ok" : "idle"}`}>{a.twitterBound ? "✓" : "—"}</span></td>
                    <td><span className={`badge badge-${a.staked ? "ok" : "idle"}`}>{a.staked ? "✓" : "—"}</span></td>
                    <td className="muted" style={{ fontSize: 10 }}>{a.lastRunStatus ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Recent logs</h2>
            <a className="aux" href="/logs">stream →</a>
          </div>
          <div className="log-stream" style={{ maxHeight: 360 }}>
            {logs.length === 0 ? (
              <div className="hint">No logs yet.</div>
            ) : (
              logs.slice(-40).map((l: any) => (
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
      </section>
    </div>
  );
}
