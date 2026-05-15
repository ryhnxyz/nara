import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { openDb, countAutomationRunsToday, recentAutomationRuns } from "@nara-bot/db";
import { ownerFromContext } from "../lib/owner";
import { configureHunt, getHuntState, huntEvents, runPoll } from "../workers/hunt";

export const automationRoute = new Hono();

const WORKER_KEY = "hunt";

function ownerHuntState(ownerEmail: string | null) {
  const base = getHuntState();
  if (!ownerEmail) return base;

  const db = openDb();
  const runStats = db.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      COALESCE(SUM(codes_found), 0) AS codes_found,
      COALESCE(SUM(codes_claimed), 0) AS codes_claimed,
      COALESCE(SUM(nara_earned), 0) AS nara_earned,
      COALESCE(SUM(CASE WHEN note LIKE '%engaged=%' THEN 1 ELSE 0 END), 0) AS engagements
    FROM automation_runs
    WHERE worker = ? AND owner_email = ?
  `).get(WORKER_KEY, ownerEmail) as any;

  const claimStats = db.prepare(`
    SELECT
      COUNT(c.id) AS found,
      COALESCE(SUM(CASE WHEN c.status IN ('claimed', 'boosted') THEN 1 ELSE 0 END), 0) AS claimed
    FROM dragonball_claims c
    INNER JOIN agents a ON a.id = c.agent_id
    WHERE a.owner_email = ?
  `).get(ownerEmail) as any;

  const targetAgentIds = base.targetAgentIds
    ? base.targetAgentIds.filter((id) => {
        const row = db.prepare("SELECT 1 FROM agents WHERE id = ? AND owner_email = ?").get(id, ownerEmail);
        return !!row;
      })
    : null;
  const currentAgentId = base.currentAgentId &&
    db.prepare("SELECT 1 FROM agents WHERE id = ? AND owner_email = ?").get(base.currentAgentId, ownerEmail)
      ? base.currentAgentId
      : null;

  return {
    ...base,
    targetAgentIds,
    runsToday: countAutomationRunsToday(db, WORKER_KEY, ownerEmail),
    totalRuns: Number(runStats?.total_runs ?? 0),
    totalCodesFound: Number(claimStats?.found ?? runStats?.codes_found ?? 0),
    totalCodesClaimed: Number(claimStats?.claimed ?? runStats?.codes_claimed ?? 0),
    totalEngagements: Number(runStats?.engagements ?? 0),
    totalNaraEarned: Number(runStats?.nara_earned ?? 0),
    currentAgentId,
  };
}

automationRoute.get("/hunt/state", (c) => c.json(ownerHuntState(ownerFromContext(c))));

automationRoute.post("/hunt/configure", async (c) => {
  type ConfigureBody = {
    enabled?: boolean;
    intervalSeconds?: number;
    autoClaim?: boolean;
    tweetBoostUrl?: string | null;
    targetAgentIds?: string[] | null;
    maxRunsPerDay?: number;
    scanDmInbox?: boolean;
    scanFeed?: boolean;
    feedLimit?: number;
    engageActivity?: boolean;
    likesPerPoll?: number;
    commentsPerPoll?: number;
    followsPerPoll?: number;
  };
  const body = (await c.req.json<ConfigureBody>().catch(() => ({}))) as ConfigureBody;
  const patch: any = {};
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.intervalSeconds !== undefined) patch.intervalSeconds = Math.max(30, Number(body.intervalSeconds));
  if (body.autoClaim !== undefined) patch.autoClaim = !!body.autoClaim;
  if (body.tweetBoostUrl !== undefined) patch.tweetBoostUrl = body.tweetBoostUrl || null;
  if (body.targetAgentIds !== undefined) patch.targetAgentIds = body.targetAgentIds ?? null;
  if (body.maxRunsPerDay !== undefined) patch.maxRunsPerDay = Math.max(1, Number(body.maxRunsPerDay));
  if (body.scanDmInbox !== undefined) patch.scanDmInbox = !!body.scanDmInbox;
  if (body.scanFeed !== undefined) patch.scanFeed = !!body.scanFeed;
  if (body.feedLimit !== undefined) patch.feedLimit = Math.max(10, Math.min(200, Number(body.feedLimit)));
  if (body.engageActivity !== undefined) patch.engageActivity = !!body.engageActivity;
  if (body.likesPerPoll !== undefined) patch.likesPerPoll = Math.max(0, Math.min(20, Number(body.likesPerPoll)));
  if (body.commentsPerPoll !== undefined) patch.commentsPerPoll = Math.max(0, Math.min(5, Number(body.commentsPerPoll)));
  if (body.followsPerPoll !== undefined) patch.followsPerPoll = Math.max(0, Math.min(10, Number(body.followsPerPoll)));
  configureHunt(patch);
  return c.json({ ok: true, state: ownerHuntState(ownerFromContext(c)) });
});

automationRoute.post("/hunt/run-now", async (c) => {
  const res = await runPoll();
  return c.json({ ok: true, ...res, state: ownerHuntState(ownerFromContext(c)) });
});

automationRoute.get("/hunt/runs", (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  const runs = recentAutomationRuns(openDb(), WORKER_KEY, limit, ownerFromContext(c));
  return c.json({ runs });
});

automationRoute.get("/hunt/stream", (c) =>
  streamSSE(c, async (stream) => {
    let closed = false;
    const send = async (data: unknown) => {
      if (closed) return;
      try {
        await stream.writeSSE({ event: "state", data: JSON.stringify(data) });
      } catch {
        closed = true;
      }
    };

    const ownerEmail = ownerFromContext(c);
    await send(ownerHuntState(ownerEmail));
    const handler = () => {
      void send(ownerHuntState(ownerEmail));
    };
    huntEvents.on("state", handler);

    const heartbeat = setInterval(() => {
      if (!closed) stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => (closed = true));
    }, 15_000);

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        closed = true;
        huntEvents.off("state", handler);
        clearInterval(heartbeat);
        resolve();
      });
    });
  })
);
