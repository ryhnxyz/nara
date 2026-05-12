"use client";

import { useEffect, useState, useTransition } from "react";

interface State {
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastRunStatus: string;
  transfers: number;
  naraSent: number;
  masterAddress: string;
  minNara: number;
  keepNara: number;
  intervalHours: number;
}

interface Props {
  initialState: State | null;
  agents: any[];
}

export function SettingsClient({ initialState, agents }: Props) {
  const [state, setState] = useState<State | null>(initialState);
  const [enabled, setEnabled] = useState(initialState?.enabled ?? false);
  const [masterAddress, setMasterAddress] = useState(initialState?.masterAddress ?? "");
  const [minNara, setMinNara] = useState(initialState?.minNara ?? 0.5);
  const [keepNara, setKeepNara] = useState(initialState?.keepNara ?? 0.05);
  const [intervalHours, setIntervalHours] = useState(initialState?.intervalHours ?? 6);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/daemon/distribute/state");
        const data = await res.json();
        setState(data);
      } catch {}
    }, 5000);
    return () => clearInterval(t);
  }, []);

  async function save() {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/daemon/distribute/configure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled, masterAddress: masterAddress.trim(), minNara, keepNara, intervalHours }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setState(data.state);
        setMessage("Saved.");
      } catch (err) {
        setMessage(`Error: ${(err as Error).message}`);
      }
    });
  }

  async function runNow() {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/daemon/distribute/run", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setState(data.state);
        setMessage(`Swept ${data.naraSent?.toFixed(4)} NARA from ${data.transfers} wallet(s).`);
      } catch (err) {
        setMessage(`Error: ${(err as Error).message}`);
      }
    });
  }

  return (
    <>
      <section className="grid-cards">
        <div className="card">
          <div className="card-label">Worker status</div>
          <div className="card-value" style={{ fontSize: 16, color: state?.enabled ? "var(--accent)" : "var(--text-dim)" }}>
            {state?.enabled ? (state.running ? "SWEEPING…" : "ENABLED") : "DISABLED"}
          </div>
          <div className="card-trend">last: {state?.lastRunStatus ?? "idle"}</div>
        </div>
        <div className="card">
          <div className="card-label">Total swept</div>
          <div className="card-value">{state?.naraSent.toFixed(4) ?? "0.00"}<span className="unit">NARA</span></div>
          <div className="card-trend">{state?.transfers ?? 0} transfers</div>
        </div>
        <div className="card">
          <div className="card-label">Master wallet</div>
          <div className="card-value" style={{ fontSize: 11, wordBreak: "break-all" }}>
            {state?.masterAddress ? state.masterAddress.slice(0, 20) + "…" : "not set"}
          </div>
          <div className="card-trend">sweep target</div>
        </div>
        <div className="card">
          <div className="card-label">Interval</div>
          <div className="card-value">{state?.intervalHours ?? 6}<span className="unit">hours</span></div>
          <div className="card-trend">min={state?.minNara} keep={state?.keepNara}</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Auto-distribute earnings</h2>
          <span className="aux muted">sweeps NARA from all agent wallets → master wallet</span>
        </div>

        <div className="form-row">
          <label>Enabled</label>
          <div className="row">
            <label className="row" style={{ gap: 6, fontSize: 11 }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span className="muted">ON = sweep automatically every interval</span>
            </label>
          </div>
        </div>

        <div className="form-row">
          <label>Master wallet address</label>
          <input
            className="input"
            placeholder="paste your main wallet address here"
            value={masterAddress}
            onChange={(e) => setMasterAddress(e.target.value)}
          />
        </div>

        <div className="form-row">
          <label>Min balance to sweep</label>
          <input className="input" type="number" step="0.01" min="0" value={minNara} onChange={(e) => setMinNara(Number(e.target.value))} />
        </div>

        <div className="form-row">
          <label>Keep in wallet (rent)</label>
          <input className="input" type="number" step="0.01" min="0" value={keepNara} onChange={(e) => setKeepNara(Number(e.target.value))} />
        </div>

        <div className="form-row">
          <label>Interval (hours)</label>
          <input className="input" type="number" min="1" max="168" value={intervalHours} onChange={(e) => setIntervalHours(Number(e.target.value))} />
        </div>

        <div className="toolbar" style={{ marginTop: 10 }}>
          <button className="btn btn-primary" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save config"}
          </button>
          <button className="btn" onClick={runNow} disabled={pending || !state?.masterAddress}>
            ▸ Run sweep now
          </button>
          {message ? <span className="hint">{message}</span> : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Agent wallets</h2>
          <span className="aux muted">these wallets are swept into the master</span>
        </div>
        {agents.length === 0 ? (
          <div className="hint">No agents yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Address</th>
                <th>Bound</th>
                <th>Staked</th>
                <th>Earned</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a: any) => (
                <tr key={a.id}>
                  <td style={{ color: "var(--accent)" }}>{a.agentId}</td>
                  <td className="muted" style={{ fontSize: 10, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {a.walletAddress ?? "—"}
                  </td>
                  <td>{a.twitterBound ? "✓" : "—"}</td>
                  <td>{a.staked ? "✓" : "—"}</td>
                  <td>{Number(a.totalEarned ?? 0).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
