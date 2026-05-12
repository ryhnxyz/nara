import { daemon } from "@/lib/daemon";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

async function load() {
  try {
    const res = await fetch(`${daemon.url}/api/distribute/state`, { cache: "no-store" });
    const state = await res.json();
    const agentsRes = await daemon.listAgents();
    return { state, agents: agentsRes.agents, error: null as string | null };
  } catch (err) {
    return { state: null, agents: [], error: (err as Error).message };
  }
}

export default async function SettingsPage() {
  const { state, agents, error } = await load();

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="kicker">Config</div>
          <h1>Settings</h1>
          <div className="page-subtitle">
            Configure auto-distribute (sweep agent earnings to a master wallet) and other bot behavior.
          </div>
        </div>
      </header>

      {error ? (
        <div className="panel" style={{ borderColor: "var(--danger)" }}>
          <div className="hint" style={{ color: "var(--danger)" }}>{error}</div>
        </div>
      ) : null}

      <SettingsClient initialState={state} agents={agents} />
    </div>
  );
}
