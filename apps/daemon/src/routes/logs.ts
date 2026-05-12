import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { openDb, recentLogs } from "@nara-bot/db";
import type { BotLog } from "@nara-bot/core";
import { logStream } from "../lib/logger";

export const logsRoute = new Hono();

logsRoute.get("/", (c) => {
  const limit = Number(c.req.query("limit") ?? 200);
  const agentId = c.req.query("agentId") ?? undefined;
  return c.json({ logs: recentLogs(openDb(), limit, agentId) });
});

logsRoute.get("/stream", (c) =>
  streamSSE(c, async (stream) => {
    let closed = false;
    const send = async (log: BotLog) => {
      if (closed) return;
      try {
        await stream.writeSSE({ event: "log", data: JSON.stringify(log) });
      } catch {
        closed = true;
      }
    };

    const initial = recentLogs(openDb(), 100);
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
