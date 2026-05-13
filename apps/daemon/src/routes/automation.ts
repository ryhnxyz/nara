import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { configureHunt, getHuntState, huntEvents, listHuntRuns, runPoll } from "../workers/hunt";

export const automationRoute = new Hono();

automationRoute.get("/hunt/state", (c) => c.json(getHuntState()));

automationRoute.post("/hunt/configure", async (c) => {
  type ConfigureBody = {
    enabled?: boolean;
    intervalSeconds?: number;
    autoClaim?: boolean;
    tweetBoostUrl?: string | null;
    targetAgentIds?: string[] | null;
    maxRunsPerDay?: number;
  };
  const body = (await c.req.json<ConfigureBody>().catch(() => ({}))) as ConfigureBody;
  const patch: any = {};
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.intervalSeconds !== undefined) patch.intervalSeconds = Math.max(30, Number(body.intervalSeconds));
  if (body.autoClaim !== undefined) patch.autoClaim = !!body.autoClaim;
  if (body.tweetBoostUrl !== undefined) patch.tweetBoostUrl = body.tweetBoostUrl || null;
  if (body.targetAgentIds !== undefined) patch.targetAgentIds = body.targetAgentIds ?? null;
  if (body.maxRunsPerDay !== undefined) patch.maxRunsPerDay = Math.max(1, Number(body.maxRunsPerDay));
  const state = configureHunt(patch);
  return c.json({ ok: true, state });
});

automationRoute.post("/hunt/run-now", async (c) => {
  const res = await runPoll();
  return c.json({ ok: true, ...res, state: getHuntState() });
});

automationRoute.get("/hunt/runs", (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  const runs = listHuntRuns(limit);
  return c.json({ runs });
});

/**
 * SSE stream of hunt worker state changes.
 */
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

    await send(getHuntState());
    const handler = (s: unknown) => {
      void send(s);
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
