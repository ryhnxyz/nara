import { daemon } from "@/lib/daemon";
import { ChatClient } from "./chat-client";

export const dynamic = "force-dynamic";

async function load() {
  try {
    const [threads, models, agents] = await Promise.all([
      daemon.aiThreads(),
      daemon.aiModels(),
      daemon.listAgents(),
    ]);
    return { threads: threads.threads, models: models.models, modelsMeta: models, agents: agents.agents, error: null as string | null };
  } catch (err) {
    return { threads: [], models: [], modelsMeta: null, agents: [], error: (err as Error).message };
  }
}

export default async function ChatPage() {
  const { threads, models, modelsMeta, agents, error } = await load();

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="kicker">AI</div>
          <h1>Agent Chat</h1>
          <div className="page-subtitle">
            Talk to your agent using the same provider as opencode ({modelsMeta?.baseUrl ?? "not configured"}).
            Each agent has context about its wallet, bindings, and on-chain state.
          </div>
        </div>
        <div className="row">
          <span className={`badge ${modelsMeta?.configured ? "badge-running" : "badge-error"}`}>
            {modelsMeta?.configured ? "AI CONFIGURED" : "AI KEY MISSING"}
          </span>
        </div>
      </header>

      {error ? (
        <div className="panel"><div className="hint" style={{ color: "var(--danger)" }}>{error}</div></div>
      ) : null}

      <ChatClient threads={threads} models={models} agents={agents} />
    </div>
  );
}
