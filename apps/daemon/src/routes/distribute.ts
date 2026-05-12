import { Hono } from "hono";
import { configureDistribute, getDistributeState, runDistribution } from "../workers/distribute";

export const distributeRoute = new Hono();

distributeRoute.get("/state", (c) => c.json(getDistributeState()));

distributeRoute.post("/configure", async (c) => {
  const body = await c.req.json<{
    enabled?: boolean;
    masterAddress?: string;
    minNara?: number;
    keepNara?: number;
    intervalHours?: number;
  }>().catch(() => ({}));
  const state = configureDistribute(body);
  return c.json({ ok: true, state });
});

distributeRoute.post("/run", async (c) => {
  try {
    const res = await runDistribution();
    return c.json({ ok: true, ...res, state: getDistributeState() });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});
