"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function AgentForm() {
  const router = useRouter();
  const [agentId, setAgentId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [referral, setReferral] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/daemon/agents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId,
            displayName: displayName || undefined,
            referral: referral || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setAgentId("");
        setDisplayName("");
        setReferral("");
        setMessage(`Created ${data.agent.agentId} — wallet will be generated on first run.`);
        router.refresh();
      } catch (err) {
        setMessage(`Error: ${(err as Error).message}`);
      }
    });
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Register new agent</h2>
        <span className="aux muted">free for 8+ chars · wallet auto-created</span>
      </div>
      <form onSubmit={submit}>
        <div className="form-row">
          <label>Agent ID</label>
          <input
            className="input"
            placeholder="lowercase, 8-32 chars, e.g. ryhn-nara-01"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label>Display name</label>
          <input
            className="input"
            placeholder="optional"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label>Referral agent-id</label>
          <input
            className="input"
            placeholder="optional — 50% discount for short IDs"
            value={referral}
            onChange={(e) => setReferral(e.target.value)}
          />
        </div>
        <div className="toolbar">
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {pending ? "Saving…" : "+ Add agent"}
          </button>
          {message ? <span className="hint">{message}</span> : null}
        </div>
      </form>
    </section>
  );
}
