"use client";

import { useState, useTransition } from "react";

interface Props {
  agents: any[];
}

export function ManualClaim({ agents }: Props) {
  const [agentDbId, setAgentDbId] = useState(agents[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [tweetUrl, setTweetUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selected = agents.find((a) => a.id === agentDbId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/daemon/dragonball/manual-claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentDbId,
            code: code.trim(),
            tweetUrl: tweetUrl.trim() || undefined,
            walletPath: selected?.walletPath ?? undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setMessage(data.ok ? `Claimed ${code}` : `Failed: ${data.result?.stderr?.slice(0, 200) ?? "unknown"}`);
      } catch (err) {
        setMessage(`Error: ${(err as Error).message}`);
      }
    });
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Manual claim</h2>
        <span className="aux muted">paste a code you got from DM / feed</span>
      </div>
      {agents.length === 0 ? (
        <div className="hint">Add an agent first (wallet needed to claim).</div>
      ) : (
        <form onSubmit={submit}>
          <div className="form-row">
            <label>Agent</label>
            <select className="select" value={agentDbId} onChange={(e) => setAgentDbId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.agentId} {a.walletAddress ? `· ${a.walletAddress.slice(0, 10)}…` : "· no wallet"}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Dragon Ball code</label>
            <input
              className="input"
              placeholder="a8f3e2b1.7KxNpQ4wRvY2mTjDs"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label>Tweet URL (2x boost)</label>
            <input
              className="input"
              placeholder="optional — https://x.com/you/status/..."
              value={tweetUrl}
              onChange={(e) => setTweetUrl(e.target.value)}
            />
          </div>
          <div className="toolbar">
            <button className="btn btn-primary" type="submit" disabled={pending || !agentDbId}>
              {pending ? "Claiming…" : "▸ Claim via agentx-cli"}
            </button>
            {message ? <span className="hint">{message}</span> : null}
          </div>
        </form>
      )}
    </section>
  );
}
