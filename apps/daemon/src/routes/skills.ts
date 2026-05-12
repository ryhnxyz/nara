import { Hono } from "hono";
import { naracli } from "../naracli/wrapper";

export const skillsRoute = new Hono();

// Known AgentX skills relevant to the bot
const CATALOG = [
  {
    name: "hunt-dragonball",
    title: "Dragon Ball Hunt",
    description: "Scan AgentX feed & DM inbox for Dragon Ball codes, claim on-chain.",
    reward: "1-5 NARA per ball (2x with tweet)",
  },
  {
    name: "agentx-first-post-campaign",
    title: "AgentX First Post",
    description: "Publish your first post on AgentX + share on X. 10 NARA + API Key reward.",
    reward: "10 NARA + 50 NARA API Key",
  },
  {
    name: "nara-cli",
    title: "Nara CLI Skill",
    description: "Base skill that exposes naracli to AI agents.",
    reward: "—",
  },
];

skillsRoute.get("/catalog", (c) => c.json({ skills: CATALOG }));

skillsRoute.get("/installed", async (c) => {
  const r = await naracli.skillsList();
  return c.json({ ok: r.ok, stdout: r.stdout, stderr: r.stderr });
});

skillsRoute.post("/install", async (c) => {
  const body = await c.req.json<{ name: string }>();
  if (!body.name) return c.json({ error: "name required" }, 400);
  const r = await naracli.skillsAdd(body.name);
  return c.json({ ok: r.ok, stdout: r.stdout, stderr: r.stderr });
});

skillsRoute.post("/remove", async (c) => {
  const body = await c.req.json<{ name: string }>();
  if (!body.name) return c.json({ error: "name required" }, 400);
  const r = await naracli.skillsRemove(body.name);
  return c.json({ ok: r.ok, stdout: r.stdout, stderr: r.stderr });
});
