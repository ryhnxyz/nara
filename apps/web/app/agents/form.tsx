"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function AgentForm() {
  const router = useRouter();
  const [agentId, setAgentId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [referral, setReferral] = useState("");
  const [xUsername, setXUsername] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [createdAgent, setCreatedAgent] = useState<any | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setCreatedAgent(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/daemon/agents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId,
            displayName: displayName || undefined,
            referral: referral || undefined,
            xUsername: xUsername || undefined,
            autoCreateWallet: true,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setAgentId("");
        setDisplayName("");
        setReferral("");
        setCreatedAgent(data.agent);
        setMessage(`Created ${data.agent.agentId}`);
        router.refresh();
      } catch (err) {
        setMessage(`Error: ${(err as Error).message}`);
      }
    });
  }

  async function fundFromMaster(agentDbId: string) {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/daemon/agents/${agentDbId}/fund-from-master`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setMessage(`Funded ${data.amount} NARA ✓  tx: ${data.txSignature?.slice(0, 12) ?? "—"}…`);
        router.refresh();
      } catch (err) {
        setMessage(`Fund error: ${(err as Error).message}`);
      }
    });
  }

  async function runFlow(agentDbId: string) {
    setMessage(null);
    // If x-username wasn't set via form (new agent not bound yet), prompt for it
    let x = xUsername.trim();
    const agent = createdAgent;
    if (!x && agent && !agent.twitterBound && !agent.xUsername) {
      const prompted = window.prompt(
        "Enter X/Twitter username (without @) for this agent. The bot uses it to build the fake bind tweet URL:",
        ""
      );
      if (!prompted) {
        setMessage("Run cancelled — X username required for first-time bind.");
        return;
      }
      x = prompted.replace(/^@/, "").trim();
      // Persist to agent so subsequent runs skip this prompt
      try {
        await fetch(`/api/daemon/agents/${agentDbId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ xUsername: x }),
        });
      } catch {}
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/daemon/agents/${agentDbId}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            autoFundFromMaster: true,
            tweetBoostAfterClaim: true,
            xUsername: x || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setMessage(`Flow started — check Live Logs for progress.`);
        router.refresh();
      } catch (err) {
        setMessage(`Run error: ${(err as Error).message}`);
      }
    });
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Register new agent</h2>
        <span className="aux muted">wallet auto-generated on create · fund from master in Settings</span>
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
        <div className="form-row">
          <label>X / Twitter username</label>
          <input
            className="input"
            placeholder="e.g. NESAM_SM (without @) — used to build fake bind tweet URL"
            value={xUsername}
            onChange={(e) => setXUsername(e.target.value.replace(/^@/, ""))}
          />
        </div>
        <div className="toolbar">
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {pending ? "Saving…" : "+ Add agent"}
          </button>
          {message ? <span className="hint">{message}</span> : null}
        </div>
      </form>

      {createdAgent ? (
        <div
          style={{
            marginTop: 14,
            padding: 12,
            background: "#05070a",
            border: "1px solid var(--accent-dim)",
            borderRadius: 4,
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.22em",
              color: "var(--accent)",
              marginBottom: 8,
            }}
          >
            AGENT CREATED
          </div>
          <div className="kv">
            <span className="k">agent-id</span>
            <span className="v" style={{ color: "var(--accent)" }}>{createdAgent.agentId}</span>
          </div>
          <div className="kv">
            <span className="k">wallet</span>
            <span className="v" style={{ wordBreak: "break-all", fontSize: 11 }}>
              {createdAgent.walletAddress ?? "(generating…)"}
            </span>
          </div>
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button
              className="btn btn-primary"
              onClick={() => fundFromMaster(createdAgent.id)}
              disabled={pending || !createdAgent.walletAddress}
            >
              ▸ Fund from master
            </button>
            <button
              className="btn"
              onClick={() => runFlow(createdAgent.id)}
              disabled={pending || !createdAgent.walletAddress}
            >
              ▸ Run full flow (auto-fund)
            </button>
            <button
              className="btn"
              onClick={() => setCreatedAgent(null)}
              disabled={pending}
            >
              hide
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8, fontSize: 11 }}>
            Need to import master wallet? Go to <a href="/settings" style={{ color: "var(--accent)" }}>Settings</a>.
          </div>
        </div>
      ) : null}
    </section>
  );
}
