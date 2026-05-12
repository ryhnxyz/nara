import { Hono } from "hono";
import { openDb, listDragonBallClaims, updateDragonBallClaim } from "@nara-bot/db";
import { agentx, extractTxSignature } from "../naracli/wrapper";
import { log } from "../lib/logger";

export const dragonballRoute = new Hono();

dragonballRoute.get("/claims", (c) => {
  const agentId = c.req.query("agentId");
  const claims = listDragonBallClaims(openDb(), agentId, 200);
  return c.json({ claims });
});

dragonballRoute.post("/manual-claim", async (c) => {
  const body = await c.req.json<{
    agentDbId: string;
    code: string;
    tweetUrl?: string;
    walletPath?: string;
  }>();

  if (!/^[a-f0-9]{8}\.[A-Za-z0-9]{10,32}$/.test(body.code)) {
    return c.json({ error: "invalid code format, expected <id>.<secret>" }, 400);
  }

  const r = await agentx.codeClaim(body.code, {
    walletPath: body.walletPath,
    agentId: body.agentDbId,
    tweetUrl: body.tweetUrl,
    timeoutMs: 120_000,
  });

  if (r.ok) {
    updateDragonBallClaim(openDb(), body.agentDbId, body.code, {
      status: body.tweetUrl ? "boosted" : "claimed",
      txSignature: extractTxSignature(r.stdout),
      tweetUrl: body.tweetUrl ?? null,
      claimedAt: new Date().toISOString(),
    });
    log({
      agentId: body.agentDbId,
      level: "success",
      scope: "dragonball.manual-claim",
      message: `Claimed ${body.code}`,
    });
  } else {
    updateDragonBallClaim(openDb(), body.agentDbId, body.code, {
      status: "failed",
      errorMessage: r.stderr.slice(0, 300) || r.stdout.slice(0, 300),
    });
  }

  return c.json({ ok: r.ok, result: r });
});

dragonballRoute.post("/check-inbox", async (c) => {
  const body = await c.req.json<{ walletPath: string; agentDbId: string; agentId: string }>();
  const { result, codes } = await agentx.dmInbox({
    walletPath: body.walletPath,
    agentId: body.agentId,
    limit: 30,
  });
  return c.json({ ok: result.ok, codes, raw: result.stdout.slice(-800) });
});
