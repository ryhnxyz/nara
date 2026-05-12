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

  try {
    const pinoFn = input.level === "success" ? "info" : input.level;
    const logObj = { scope: input.scope, agentId: input.agentId, ...input.meta };
    if (pinoFn === "debug") pinoLogger.debug(logObj, input.message);
    else if (pinoFn === "warn") pinoLogger.warn(logObj, input.message);
    else if (pinoFn === "error") pinoLogger.error(logObj, input.message);
    else pinoLogger.info(logObj, input.message);
  } catch {
    // pino transport may not be ready — don't crash the process
    console.log(`[${input.level}] ${input.scope}: ${input.message}`);
  }

  logStream.emit("log", persisted);
  return persisted;
}

export const logger = pinoLogger;
