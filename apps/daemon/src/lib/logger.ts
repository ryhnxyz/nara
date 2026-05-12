import pino from "pino";
import { EventEmitter } from "node:events";
import { insertLog, openDb, type Db } from "@nara-bot/db";
import type { BotLog, LogLevel } from "@nara-bot/core";

const pinoLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
    : undefined,
});

export const logStream = new EventEmitter();
logStream.setMaxListeners(100);

let sharedDb: Db | null = null;
function db(): Db {
  if (!sharedDb) sharedDb = openDb();
  return sharedDb;
}

export interface LogInput {
  agentId?: string | null;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: Record<string, unknown> | null;
}

export function log(input: LogInput): BotLog {
  const persisted = insertLog(db(), {
    agentId: input.agentId ?? null,
    level: input.level,
    scope: input.scope,
    message: input.message,
    meta: input.meta ?? null,
  });

  const pinoFn = input.level === "success" ? "info" : input.level;
  const method = (pinoLogger as unknown as Record<string, (obj: Record<string, unknown>, msg: string) => void>)[pinoFn];
  method?.({ scope: input.scope, agentId: input.agentId, ...input.meta }, input.message);

  logStream.emit("log", persisted);
  return persisted;
}

export const logger = pinoLogger;
