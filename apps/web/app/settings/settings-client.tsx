"use client";

import { useEffect, useState, useTransition } from "react";

interface DistState {
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

interface MasterState {
  imported: boolean;
  path?: string;
  address: string | null;
  balance: number | null;
}

interface Props {
  initialState: DistState | null;
  agents: any[];
}

const LS_MASTER_KEY = "nara.masterWallet.v1"; // local reminder — actual key is stored server-side

export function SettingsClient({ initialState, agents }: Props) {
  const [state, setState] = useState<DistState | null>(initialState);
  const [enabled, setEnabled] = useState(initialState?.enabled ?? false);
  const [masterSetting, setMasterSetting] = useState(initialState?.masterAddress ?? "");
  const [minNara, setMinNara] = useState(initialState?.minNara ?? 0.5);
  const [keepNara, setKeepNara] = useState(initialState?.keepNara ?? 0.05);
  const [intervalHours, setIntervalHours] = useState(initialState?.intervalHours ?? 6);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [masterState, setMasterState] = useState<MasterState>({ imported: false, address: null, balance: null });
  const [importMode, setImportMode] = useState<"private" | "mnemonic">("private");
  const [importSecret, setImportSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [masterMsg, setMasterMsg] = useState<string | null>(null);

  async function refreshMaster() {
    try {
      const res = await fetch("/api/daemon/master-wallet/state");
      const data = await res.json();
      setMasterState(data);
      // Auto-fill sweep target if master exists and distribute target is empty
      if (data.address && !masterSetting) {
        setMasterSetting(data.address);
      }
    } catch {}
  }

  useEffect(() => {
    refreshMaster();
    // Keep reminder in localStorage that a key exists (not the key itself)
    try {
      const flag = localStorage.getItem(LS_MASTER_KEY);
      if (!flag && masterState.imported) {
        localStorage.setItem(LS_MASTER_KEY, "imported");
      }
    } catch {}
    const t = setInterval(async () => {
      try {
        const r1 = await fetch("/api/daemon/distribute/state");
        const d1 = await r1.json();
        setState(d1);
      } catch {}
      refreshMaster();
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/daemon/distribute/configure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled, masterAddress: masterSetting.trim(), minNara, keepNara, intervalHours }),
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
        setMessage(`Swept ${data.naraSent?.toFixed?.(4) ?? 0} NARA from ${data.transfers ?? 0} wallet(s).`);
      } catch (err) {
        setMessage(`Error: ${(err as Error).message}`);
      }
    });
  }

  async function importMaster(e: React.FormEvent) {
    e.preventDefault();
    setMasterMsg(null);
    const trimmed = importSecret.trim();
    if (!trimmed) {
      setMasterMsg("paste private key or mnemonic");
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch("/api/daemon/master-wallet/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            importMode === "private" ? { privateKey: trimmed } : { mnemonic: trimmed }
          ),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setMasterState({ imported: true, address: data.address, balance: data.balance, path: data.path });
        setImportSecret("");
        setShowSecret(false);
        try {
          localStorage.setItem(LS_MASTER_KEY, "imported");
        } catch {}
        setMasterMsg(`Imported: ${data.address}`);
        // Auto-fill distribute target
        if (data.address && !masterSetting) setMasterSetting(data.address);
      } catch (err) {
        setMasterMsg(`Error: ${(err as Error).message}`);
      }
    });
  }

  async function removeMaster() {
    if (!confirm("Remove imported master wallet from server? The wallet file will be deleted.")) return;
    setMasterMsg(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/daemon/master-wallet/remove", { method: "POST" });
        if (!res.ok) throw new Error(await res.text());
        setMasterState({ imported: false, address: null, balance: null });
        try {
          localStorage.removeItem(LS_MASTER_KEY);
        } catch {}
        setMasterMsg("Removed.");
      } catch (err) {
        setMasterMsg(`Error: ${(err as Error).message}`);
      }
    });
  }

  return (
    <>
      <section className="grid-cards">
        <div className="card">
          <div className="card-label">Master wallet</div>
          <div
            className="card-value"
            style={{ fontSize: 14, color: masterState.imported ? "var(--accent)" : "var(--text-dim)" }}
          >
            {masterState.imported ? "IMPORTED" : "NOT SET"}
          </div>
          <div className="card-trend" style={{ fontSize: 10, wordBreak: "break-all" }}>
            {masterState.address ? `${masterState.address.slice(0, 20)}…` : "import in section below"}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Master balance</div>
          <div className="card-value">
            {masterState.balance !== null ? masterState.balance.toFixed(4) : "—"}
            <span className="unit">NARA</span>
          </div>
          <div className="card-trend">used to fund agents</div>
        </div>
        <div className="card">
          <div className="card-label">Worker status</div>
          <div
            className="card-value"
            style={{ fontSize: 16, color: state?.enabled ? "var(--accent)" : "var(--text-dim)" }}
          >
            {state?.enabled ? (state.running ? "SWEEPING…" : "ENABLED") : "DISABLED"}
          </div>
          <div className="card-trend">last: {state?.lastRunStatus ?? "idle"}</div>
        </div>
        <div className="card">
          <div className="card-label">Total swept</div>
          <div className="card-value">
            {(state?.naraSent ?? 0).toFixed(4)}<span className="unit">NARA</span>
          </div>
          <div className="card-trend">{state?.transfers ?? 0} transfers</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Master wallet</h2>
          <span className="aux muted">used to fund agent wallets + sweep target</span>
        </div>

        {masterState.imported ? (
          <>
            <div className="kv"><span className="k">address</span><span className="v" style={{ wordBreak: "break-all", color: "var(--accent)" }}>{masterState.address}</span></div>
            <div className="kv"><span className="k">balance</span><span className="v">{masterState.balance !== null ? `${masterState.balance} NARA` : "—"}</span></div>
            <div className="kv"><span className="k">status</span><span className="v" style={{ color: "var(--accent)" }}>stored on server (/data/master-wallet.json, encrypted filesystem perms)</span></div>
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button className="btn btn-danger" onClick={removeMaster} disabled={pending}>Remove master wallet</button>
              {masterMsg ? <span className="hint">{masterMsg}</span> : null}
            </div>
          </>
        ) : (
          <form onSubmit={importMaster}>
            <div className="hint" style={{ marginBottom: 10 }}>
              Import the wallet that will fund agents and receive swept earnings.
              Stored as <code>data/master-wallet.json</code> on the server (chmod 600).
            </div>
            <div className="form-row">
              <label>Import mode</label>
              <div className="row">
                <label className="row" style={{ gap: 6, fontSize: 11 }}>
                  <input type="radio" checked={importMode === "private"} onChange={() => setImportMode("private")} />
                  Private key
                </label>
                <label className="row" style={{ gap: 6, fontSize: 11 }}>
                  <input type="radio" checked={importMode === "mnemonic"} onChange={() => setImportMode("mnemonic")} />
                  Mnemonic (12/24 words)
                </label>
              </div>
            </div>
            <div className="form-row">
              <label>{importMode === "private" ? "Private key" : "Mnemonic"}</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="input"
                  type={showSecret ? "text" : "password"}
                  placeholder={importMode === "private" ? "base58 or JSON array" : "12 or 24 words"}
                  value={importSecret}
                  onChange={(e) => setImportSecret(e.target.value)}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowSecret((v) => !v)}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {showSecret ? "hide" : "show"}
                </button>
              </div>
            </div>
            <div className="toolbar">
              <button className="btn btn-primary" type="submit" disabled={pending || !importSecret.trim()}>
                {pending ? "Importing…" : "▸ Import wallet"}
              </button>
              {masterMsg ? <span className="hint">{masterMsg}</span> : null}
            </div>
          </form>
        )}
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
          <label>Sweep target address</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="input"
              placeholder={masterState.address ?? "paste destination wallet address"}
              value={masterSetting}
              onChange={(e) => setMasterSetting(e.target.value)}
            />
            {masterState.address ? (
              <button
                type="button"
                className="btn"
                onClick={() => setMasterSetting(masterState.address!)}
                style={{ whiteSpace: "nowrap" }}
              >
                use master
              </button>
            ) : null}
          </div>
        </div>

        <div className="form-row">
          <label>Min balance to sweep</label>
          <input
            className="input"
            type="number"
            step="0.01"
            min="0"
            value={minNara}
            onChange={(e) => setMinNara(Number(e.target.value))}
          />
        </div>

        <div className="form-row">
          <label>Keep in wallet (rent)</label>
          <input
            className="input"
            type="number"
            step="0.01"
            min="0"
            value={keepNara}
            onChange={(e) => setKeepNara(Number(e.target.value))}
          />
        </div>

        <div className="form-row">
          <label>Interval (hours)</label>
          <input
            className="input"
            type="number"
            min="1"
            max="168"
            value={intervalHours}
            onChange={(e) => setIntervalHours(Number(e.target.value))}
          />
        </div>

        <div className="toolbar" style={{ marginTop: 10 }}>
          <button className="btn btn-primary" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save config"}
          </button>
          <button className="btn" onClick={runNow} disabled={pending || !masterSetting}>
            ▸ Run sweep now
          </button>
          {message ? <span className="hint">{message}</span> : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Agent wallets</h2>
          <span className="aux muted">these wallets are funded by master and swept back</span>
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
                  <td
                    className="muted"
                    style={{ fontSize: 10, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}
                  >
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
