import { daemon } from "@/lib/daemon";
import { AutomationClient } from "./automation-client";

export const dynamic = "force-dynamic";

async function load() {
  try {
    const [stateRes, runsRes, agentsRes] = await Promise.all([
      fetch(`${daemon.url}/api/automation/hunt/state`, { cache: "no-store" }).then((r) => r.json()),
      fetch(`${daemon.url}/api/automation/hunt/runs?limit=50`, { cache: "no-store" }).then((r) => r.json()),
      daemon.listAgents(),
    ]);
    return { state: stateRes, runs: runsRes.runs ?? [], agents: agentsRes.agents, error: null as string | null };
  } catch (err) {
    return { state: null, runs: [], agents: [], error: (err as Error).message };
  }
}

export default async function AutomationPage() {
  const { state, runs, agents, error } = await load();

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="kicker">Automation</div>
          <h1>Dragon Ball Hunt Worker</h1>
          <div className="page-subtitle">
            Poll agentx-cli DM inbox automatically for every agent. Auto-claim codes as they arrive.
            Runs 24/7 while daemon is alive.
          </div>
        </div>
      </header>

      {error ? (
        <div className="panel" style={{ borderColor: "var(--danger)" }}>
          <div className="hint" style={{ color: "var(--danger)" }}>{error}</div>
        </div>
      ) : null}

      <AutomationClient initialState={state} initialRuns={runs} agents={agents} />
    </div>
  );
}
