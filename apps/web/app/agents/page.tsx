import { daemon } from "@/lib/daemon";
import { AgentList } from "./agent-list";
import { AgentForm } from "./form";

export const dynamic = "force-dynamic";

async function load() {
  try {
    const res = await daemon.listAgents();
    return { agents: res.agents, error: null as string | null };
  } catch (err) {
    return { agents: [], error: (err as Error).message };
  }
}

export default async function AgentsPage() {
  const { agents, error } = await load();

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="kicker">Identity</div>
          <h1>Agents</h1>
          <div className="page-subtitle">
            Register Nara agents. Each agent gets its own wallet + runs the full bot flow:
            create → fund → register → bind X → stake → submit tweet → claim Dragon Balls.
          </div>
        </div>
      </header>

      <AgentForm />

      {error ? (
        <div className="panel" style={{ borderColor: "var(--danger)" }}>
          <div className="hint" style={{ color: "var(--danger)" }}>Daemon: {error}</div>
        </div>
      ) : null}

      <AgentList initialAgents={agents} />
    </div>
  );
}
