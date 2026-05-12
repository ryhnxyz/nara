import { daemon } from "@/lib/daemon";
import { ManualClaim } from "./manual-claim";
import { LogViewer } from "@/components/log-viewer";

export const dynamic = "force-dynamic";

async function load() {
  try {
    const [claimsRes, agentsRes] = await Promise.all([
      daemon.dragonBallClaims(),
      daemon.listAgents(),
    ]);
    return { claims: claimsRes.claims, agents: agentsRes.agents, error: null as string | null };
  } catch (err) {
    return { claims: [], agents: [], error: (err as Error).message };
  }
}

export default async function DragonBallPage() {
  const { claims, agents, error } = await load();
  const claimed = claims.filter((c: any) => c.status === "claimed" || c.status === "boosted").length;
  const failed = claims.filter((c: any) => c.status === "failed").length;

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="kicker">Campaign</div>
          <h1>Dragon Ball Hunt</h1>
          <div className="page-subtitle">
            Harvest Dragon Ball codes from AgentX DM inbox, claim on-chain via agentx-cli.
            Format: <code>&lt;8hex&gt;.&lt;22+alnum&gt;</code>. Tweet boost gives 2x reward.
          </div>
        </div>
      </header>

      {error ? (
        <div className="panel" style={{ borderColor: "var(--danger)" }}>
          <div className="hint">{error}</div>
        </div>
      ) : null}

      <section className="grid-cards">
        <div className="card">
          <div className="card-label">Discoveries</div>
          <div className="card-value">{claims.length}</div>
          <div className="card-trend">total codes discovered</div>
        </div>
        <div className="card">
          <div className="card-label">Claimed</div>
          <div className="card-value" style={{ color: "var(--accent)" }}>{claimed}</div>
          <div className="card-trend">on-chain confirmed</div>
        </div>
        <div className="card">
          <div className="card-label">Failed</div>
          <div className="card-value" style={{ color: "var(--danger)" }}>{failed}</div>
          <div className="card-trend">check logs for reasons</div>
        </div>
        <div className="card">
          <div className="card-label">Agents</div>
          <div className="card-value">{agents.length}</div>
          <div className="card-trend">hunting in rotation</div>
        </div>
      </section>

      <ManualClaim agents={agents} />

      <section className="panel">
        <div className="panel-header">
          <h2>Claim history</h2>
          <span className="aux">latest {Math.min(claims.length, 200)}</span>
        </div>
        {claims.length === 0 ? (
          <div className="hint">
            No Dragon Ball codes discovered yet. Run an agent flow (Agents → run flow) — the daemon will check
            <code> agentx-cli dm-inbox</code> automatically.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Discovered</th>
                  <th>Agent</th>
                  <th>Code</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Tx</th>
                  <th>Tweet</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c: any) => {
                  const agent = agents.find((a: any) => a.id === c.agentId);
                  return (
                    <tr key={c.id}>
                      <td className="muted">{new Date(c.discoveredAt).toLocaleTimeString()}</td>
                      <td style={{ color: "var(--accent)" }}>{agent?.agentId ?? c.agentId.slice(-6)}</td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{c.code}</td>
                      <td>{c.source}</td>
                      <td>
                        <span className={`badge badge-${statusBadge(c.status)}`}>{c.status}</span>
                      </td>
                      <td className="muted" style={{ fontSize: 10 }}>
                        {c.txSignature ? c.txSignature.slice(0, 10) + "…" : "—"}
                      </td>
                      <td className="muted" style={{ fontSize: 10, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {c.tweetUrl ?? "—"}
                      </td>
                      <td className="muted" style={{ maxWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {c.errorMessage ?? ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Live worker logs</h2>
          <span className="aux">SSE · scoped to dragonball + agentx</span>
        </div>
        <LogViewer scopeFilter="dragonball|agentx|flow" height={360} />
      </section>
    </div>
  );
}

function statusBadge(s: string): string {
  if (s === "claimed" || s === "boosted") return "running";
  if (s === "failed") return "error";
  if (s === "pending") return "info";
  return "idle";
}
