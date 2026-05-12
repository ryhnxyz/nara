import { daemon } from "@/lib/daemon";
import { SkillsClient } from "./skills-client";

export const dynamic = "force-dynamic";

async function load() {
  try {
    const [cat, inst] = await Promise.all([
      daemon.skillsCatalog(),
      daemon.skillsInstalled().catch(() => ({ stdout: "", stderr: "", ok: false })),
    ]);
    return { catalog: cat.skills, installed: inst, error: null as string | null };
  } catch (err) {
    return { catalog: [], installed: { stdout: "", stderr: "" }, error: (err as Error).message };
  }
}

export default async function SkillsPage() {
  const { catalog, installed, error } = await load();

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="kicker">Skills</div>
          <h1>AgentX Skills</h1>
          <div className="page-subtitle">
            Install Nara agent skills via <code>naracli skills add</code>. Skills are markdown
            instructions injected into your agents so they can run campaigns autonomously.
          </div>
        </div>
      </header>

      {error ? <div className="panel"><div className="hint" style={{ color: "var(--danger)" }}>{error}</div></div> : null}

      <SkillsClient catalog={catalog} installedRaw={installed.stdout || ""} />
    </div>
  );
}
