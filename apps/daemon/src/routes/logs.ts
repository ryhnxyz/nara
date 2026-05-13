import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { openDb, recentLogs, listAgents } from "@nara-bot/db";
import type { BotLog } from "@nara-bot/core";
import { logStream } from "../lib/logger";
import { ownerFromContext } from "../lib/owner";

export const logsRoute = new Hono();

logsRoute.get("/", (c) => {
  const owner = ownerFromContext(c);
  const limit = Number(c.req.query("limit") ?? 200);
  const agentId = c.req.query("agentId") ?? undefined;
  const db = openDb();
  const logs = recentLogs(db, limit, agentId);
  if (!owner) return c.json({ logs });
  // Filter to only agents owned by this user (plus untagged system logs with no agent_id)
  const ownedAgentIds = new Set(listAgents(db, owner).map((a) => a.id));
  const filtered = logs.filter((l) => !l.agentId || ownedAgentIds.has(l.agentId));
  return c.json({ logs: filtered });
});

logsRoute.get("/stream", (c) =>
  streamSSE(c, async (stream) => {
    const owner = ownerFromContext(c);
    const db = openDb();
    const ownedAgentIds = owner ? new Set(listAgents(db, owner).map((a) => a.id)) : null;
    let closed = false;
    const send = async (entry: BotLog) => {
      if (closed) return;
      if (ownedAgentIds && entry.agentId && !ownedAgentIds.has(entry.agentId)) return;
      try {
        await stream.writeSSE({ event: "log", data: JSON.stringify(entry) });
      } catch {
        closed = true;
      }
    };

    const initial = recentLogs(db, 100);
    for (const entry of initial) await send(entry);

    const handler = (entry: BotLog) => {
      void send(entry);
    };
    logStream.on("log", handler);

    const heartbeat = setInterval(() => {
      if (!closed) stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => (closed = true));
    }, 15_000);

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        closed = true;
        logStream.off("log", handler);
        clearInterval(heartbeat);
        resolve();
      });
    });
  })
);
