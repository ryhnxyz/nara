import { Hono } from "hono";
import {
  createAgentRecord,
  deleteAgent,
  getAgent,
  listAgents,
  openDb,
  patchAgent,
  latestFlowRun,
} from "@nara-bot/db";
import { isValidAgentId, sanitizeAgentId } from "@nara-bot/core";
import { log } from "../lib/logger";
import { cancelFlow, isFlowActive, runFullFlow } from "../flow/runner";

export const agentsRoute = new Hono();

agentsRoute.get("/", (c) => {
  const db = openDb();
  const agents = listAgents(db).map((a) => ({
    ...a,
    activeFlow: isFlowActive(a.id),
    lastRun: latestFlowRun(db, a.id),
  }));
  return c.json({ agents });
});

agentsRoute.post("/", async (c) => {
  const body = await c.req.json<{
    agentId: string;
    displayName?: string;
    referral?: string;
  }>();
  const cleaned = sanitizeAgentId(body.agentId ?? "");
  if (!isValidAgentId(cleaned)) {
    return c.json({ error: "agent-id must be 7-32 chars, lowercase alphanumeric + hyphens" }, 400);
  }
  try {
    const agent = createAgentRecord(openDb(), {
      agentId: cleaned,
      displayName: body.displayName,
      referral: body.referral ?? null,
    });
    log({ agentId: agent.id, level: "success", scope: "agents", message: `created ${agent.agentId}` });
    return c.json({ agent }, 201);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("UNIQUE")) return c.json({ error: "agent-id already exists locally" }, 409);
    return c.json({ error: msg }, 500);
  }
});

agentsRoute.get("/:id", (c) => {
  const db = openDb();
  const agent = getAgent(db, c.req.param("id"));
  if (!agent) return c.json({ error: "not found" }, 404);
  return c.json({ agent, lastRun: latestFlowRun(db, agent.id), activeFlow: isFlowActive(agent.id) });
});

agentsRoute.patch("/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  patchAgent(openDb(), c.req.param("id"), body as any);
  return c.json({ ok: true });
});

agentsRoute.delete("/:id", (c) => {
  deleteAgent(openDb(), c.req.param("id"));
  return c.json({ ok: true });
});

agentsRoute.post("/:id/run", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    bindTweetUrl?: string;
    dailyTweetUrl?: string;
    tweetBoostAfterClaim?: boolean;
    skipFirstPost?: boolean;
    skipDailyTweet?: boolean;
  }>().catch(() => ({}));

  if (isFlowActive(id)) return c.json({ error: "flow already running" }, 409);

  runFullFlow(id, body).catch((err) => {
    log({ agentId: id, level: "error", scope: "flow", message: `flow crashed: ${(err as Error).message}` });
  });
  return c.json({ ok: true, started: true });
});

agentsRoute.post("/:id/cancel", (c) => {
  const ok = cancelFlow(c.req.param("id"));
  return c.json({ ok });
});
