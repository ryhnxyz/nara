"use client";

import { useState, useTransition } from "react";

interface SkillInfo {
  name: string;
  title: string;
  description: string;
  reward: string;
}

interface Props {
  catalog: SkillInfo[];
  installedRaw: string;
}

export function SkillsClient({ catalog, installedRaw }: Props) {
  const [output, setOutput] = useState(installedRaw);
  const [pending, startTransition] = useTransition();
  const [busySkill, setBusySkill] = useState<string | null>(null);

  async function call(path: string, body?: any) {
    const res = await fetch(`/api/daemon${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    return data;
  }

  async function install(name: string) {
    setBusySkill(name);
    startTransition(async () => {
      const data = await call("/skills/install", { name });
      setOutput(data.stdout || data.stderr || "done");
      setBusySkill(null);
    });
  }

  async function remove(name: string) {
    setBusySkill(name);
    startTransition(async () => {
      const data = await call("/skills/remove", { name });
      setOutput(data.stdout || data.stderr || "done");
      setBusySkill(null);
    });
  }

  async function refresh() {
    const res = await fetch("/api/daemon/skills/installed");
    const data = await res.json();
    setOutput(data.stdout || data.stderr || "");
  }

  return (
    <>
      <section className="grid-cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        {catalog.map((s) => (
          <div key={s.name} className="panel" style={{ margin: 0 }}>
            <div className="panel-header">
              <h2>{s.title}</h2>
              <span className="aux muted">{s.name}</span>
            </div>
            <div className="hint" style={{ lineHeight: 1.6 }}>{s.description}</div>
            <div className="kv" style={{ marginTop: 10 }}>
              <span className="k">reward</span>
              <span className="v" style={{ color: "var(--accent)" }}>{s.reward}</span>
            </div>
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button
                className="btn btn-primary"
                disabled={pending && busySkill === s.name}
                onClick={() => install(s.name)}
              >
                {busySkill === s.name ? "…" : "↓ Install"}
              </button>
              <button
                className="btn btn-danger"
                disabled={pending && busySkill === s.name}
                onClick={() => remove(s.name)}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Installed skills (raw output)</h2>
          <button className="btn" onClick={refresh}>refresh</button>
        </div>
        <pre
          style={{
            background: "#05070a",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: 12,
            fontSize: 11,
            color: "var(--text-dim)",
            maxHeight: 320,
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {output || "(no output — run naracli skills list)"}
        </pre>
      </section>
    </>
  );
}
