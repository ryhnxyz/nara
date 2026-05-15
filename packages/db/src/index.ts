import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createId,
  nowIso,
  type BotLog,
  type DragonBallClaim,
  type FlowRun,
  type FlowStepRecord,
  type NaraAgent,
} from "@nara-bot/core";
import { schemaSql, migrationsSql } from "./schema";

export type Db = Database.Database;

export function databasePath(): string {
  return resolve(process.env.DATABASE_PATH ?? "./data/nara-bot.db");
}

let shared: Db | null = null;
export function openDb(): Db {
  if (shared) return shared;
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  shared = db;
  return db;
}

export function initDb(db = openDb()): void {
  db.exec(schemaSql);
  // Apply idempotent column-add migrations. SQLite lacks IF NOT EXISTS for ADD COLUMN,
  // so we swallow "duplicate column" errors.
  for (const sql of migrationsSql) {
    try {
      db.exec(sql);
    } catch (err) {
      const msg = (err as Error).message;
      if (!/duplicate column name|no such table/i.test(msg)) throw err;
    }
  }
}

// -------- Agents --------
export function listAgents(db: Db, ownerEmail?: string | null): NaraAgent[] {
  const rows = ownerEmail
    ? db.prepare("SELECT * FROM agents WHERE owner_email = ? ORDER BY created_at DESC").all(ownerEmail) as any[]
    : db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all() as any[];
  return rows.map(rowToAgent);
}

export function getAgent(db: Db, id: string, ownerEmail?: string | null): NaraAgent | null {
  const row = ownerEmail
    ? db.prepare("SELECT * FROM agents WHERE id = ? AND owner_email = ?").get(id, ownerEmail) as any
    : db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
  return row ? rowToAgent(row) : null;
}

export function getAgentByAgentId(db: Db, agentId: string, ownerEmail?: string | null): NaraAgent | null {
  const row = ownerEmail
    ? db.prepare("SELECT * FROM agents WHERE agent_id = ? AND owner_email = ?").get(agentId, ownerEmail) as any
    : db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as any;
  return row ? rowToAgent(row) : null;
}

export function createAgentRecord(
  db: Db,
  input: { agentId: string; displayName?: string; referral?: string | null; ownerEmail?: string | null }
): NaraAgent {
  const now = nowIso();
  const agent: NaraAgent = {
    id: createId("agent"),
    agentId: input.agentId,
    displayName: input.displayName ?? input.agentId,
    status: "idle",
    walletPath: null,
    walletAddress: null,
    xUsername: null,
    twitterBound: false,
    staked: false,
    firstPostDone: false,
    referral: input.referral ?? null,
    totalEarned: 0,
    lastRunAt: null,
    lastRunStatus: null,
    ownerEmail: input.ownerEmail ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(`
    INSERT INTO agents (
      id, agent_id, display_name, status,
      wallet_path, wallet_address, x_username,
      twitter_bound, staked, first_post_done,
      referral, total_earned, last_run_at, last_run_status,
      owner_email, created_at, updated_at
    ) VALUES (
      @id, @agentId, @displayName, @status,
      @walletPath, @walletAddress, @xUsername,
      @twitterBound, @staked, @firstPostDone,
      @referral, @totalEarned, @lastRunAt, @lastRunStatus,
      @ownerEmail, @createdAt, @updatedAt
    )
  `).run({
    ...agent,
    twitterBound: agent.twitterBound ? 1 : 0,
    staked: agent.staked ? 1 : 0,
    firstPostDone: agent.firstPostDone ? 1 : 0,
  });
  return agent;
}

export function patchAgent(db: Db, id: string, patch: Partial<NaraAgent>): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id, updatedAt: nowIso() };
  for (const [key, val] of Object.entries(patch)) {
    if (key === "id" || key === "agentId" || key === "createdAt") continue;
    const col = snake(key);
    fields.push(`${col} = @${key}`);
    if (typeof val === "boolean") values[key] = val ? 1 : 0;
    else values[key] = val;
  }
  fields.push("updated_at = @updatedAt");
  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = @id`).run(values);
}

export function deleteAgent(db: Db, id: string): void {
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
}

// -------- Logs --------
export function insertLog(db: Db, log: Omit<BotLog, "id" | "createdAt">): BotLog {
  const full: BotLog = { ...log, id: createId("log"), createdAt: nowIso() };
  db.prepare(`
    INSERT INTO bot_logs (id, agent_id, level, scope, message, meta_json, created_at)
    VALUES (@id, @agentId, @level, @scope, @message, @metaJson, @createdAt)
  `).run({
    id: full.id,
    agentId: full.agentId ?? null,
    level: full.level,
    scope: full.scope,
    message: full.message,
    metaJson: full.meta ? JSON.stringify(full.meta) : null,
    createdAt: full.createdAt,
  });
  return full;
}

export function recentLogs(db: Db, limit = 200, agentId?: string): BotLog[] {
  const rows = agentId
    ? db.prepare("SELECT * FROM bot_logs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").all(agentId, limit)
    : db.prepare("SELECT * FROM bot_logs ORDER BY created_at DESC LIMIT ?").all(limit);
  return (rows as any[]).map(rowToLog).reverse();
}

// -------- Flow runs --------
export function startFlowRun(db: Db, agentId: string): FlowRun {
  const run: FlowRun = {
    id: createId("run"),
    agentId,
    status: "running",
    startedAt: nowIso(),
    finishedAt: null,
    steps: [],
  };
  db.prepare(`
    INSERT INTO flow_runs (id, agent_id, status, started_at, finished_at, steps_json)
    VALUES (@id, @agentId, @status, @startedAt, @finishedAt, @stepsJson)
  `).run({ ...run, stepsJson: JSON.stringify(run.steps) });
  return run;
}

export function updateFlowRun(db: Db, id: string, patch: Partial<FlowRun>): void {
  if (patch.steps) {
    db.prepare("UPDATE flow_runs SET steps_json = ? WHERE id = ?").run(JSON.stringify(patch.steps), id);
  }
  if (patch.status) {
    db.prepare("UPDATE flow_runs SET status = ? WHERE id = ?").run(patch.status, id);
  }
  if (patch.finishedAt !== undefined) {
    db.prepare("UPDATE flow_runs SET finished_at = ? WHERE id = ?").run(patch.finishedAt, id);
  }
}

export function latestFlowRun(db: Db, agentId: string): FlowRun | null {
  const row = db.prepare(
    "SELECT * FROM flow_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1"
  ).get(agentId) as any;
  return row ? rowToRun(row) : null;
}

export function recentFlowRuns(db: Db, limit = 20): FlowRun[] {
  const rows = db.prepare("SELECT * FROM flow_runs ORDER BY started_at DESC LIMIT ?").all(limit) as any[];
  return rows.map(rowToRun);
}

// -------- Dragon Ball --------
export function upsertDragonBallDiscovery(
  db: Db,
  input: { agentId: string; code: string; source: DragonBallClaim["source"]; rewardHint?: string | null }
): boolean {
  const r = db.prepare(`
    INSERT OR IGNORE INTO dragonball_claims (id, agent_id, code, source, status, reward_hint, discovered_at)
    VALUES (?, ?, ?, ?, 'discovered', ?, ?)
  `).run(createId("ball"), input.agentId, input.code, input.source, input.rewardHint ?? null, nowIso());
  return r.changes > 0;
}

export function updateDragonBallClaim(
  db: Db,
  agentId: string,
  code: string,
  patch: Partial<DragonBallClaim>
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { agentId, code };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id" || k === "agentId" || k === "code") continue;
    fields.push(`${snake(k)} = @${k}`);
    values[k] = v;
  }
  if (!fields.length) return;
  db.prepare(`UPDATE dragonball_claims SET ${fields.join(", ")} WHERE agent_id = @agentId AND code = @code`).run(values);
}

export function listDragonBallClaims(db: Db, agentId?: string, limit = 200): DragonBallClaim[] {
  const rows = agentId
    ? db.prepare("SELECT * FROM dragonball_claims WHERE agent_id = ? ORDER BY discovered_at DESC LIMIT ?").all(agentId, limit)
    : db.prepare("SELECT * FROM dragonball_claims ORDER BY discovered_at DESC LIMIT ?").all(limit);
  return (rows as any[]).map(rowToClaim);
}

// -------- Chat --------
export interface ChatMessage {
  id: string;
  threadId: string;
  agentId: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

export function appendChatMessage(
  db: Db,
  input: Omit<ChatMessage, "id" | "createdAt"> & { ownerEmail?: string | null }
): ChatMessage {
  const msg: ChatMessage = { ...input, id: createId("msg"), createdAt: nowIso() };
  db.prepare(`
    INSERT INTO chat_messages (id, thread_id, agent_id, role, content, owner_email, created_at)
    VALUES (@id, @threadId, @agentId, @role, @content, @ownerEmail, @createdAt)
  `).run({ ...msg, ownerEmail: (input as any).ownerEmail ?? null });
  return msg;
}

export function threadMessages(db: Db, threadId: string, limit = 100, ownerEmail?: string | null): ChatMessage[] {
  const rows = ownerEmail
    ? db.prepare(
        "SELECT * FROM chat_messages WHERE thread_id = ? AND owner_email = ? ORDER BY created_at ASC LIMIT ?"
      ).all(threadId, ownerEmail, limit) as any[]
    : db.prepare(
        "SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?"
      ).all(threadId, limit) as any[];
  return rows.map(rowToMsg);
}

export function listThreads(
  db: Db,
  ownerEmail?: string | null
): Array<{ threadId: string; agentId: string | null; lastAt: string; preview: string }> {
  const rows = (ownerEmail
    ? db.prepare(`
        SELECT thread_id, agent_id, MAX(created_at) as last_at,
          (SELECT content FROM chat_messages m2 WHERE m2.thread_id = m.thread_id AND m2.owner_email = ? ORDER BY created_at DESC LIMIT 1) as preview
        FROM chat_messages m WHERE owner_email = ?
        GROUP BY thread_id ORDER BY last_at DESC LIMIT 100
      `).all(ownerEmail, ownerEmail)
    : db.prepare(`
        SELECT thread_id, agent_id, MAX(created_at) as last_at,
          (SELECT content FROM chat_messages m2 WHERE m2.thread_id = m.thread_id ORDER BY created_at DESC LIMIT 1) as preview
        FROM chat_messages m GROUP BY thread_id ORDER BY last_at DESC LIMIT 100
      `).all()) as any[];
  return rows.map((r) => ({
    threadId: r.thread_id,
    agentId: r.agent_id ?? null,
    lastAt: r.last_at,
    preview: String(r.preview ?? "").slice(0, 120),
  }));
}

// -------- Helpers --------
function snake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}


export function deleteThread(db: Db, threadId: string, ownerEmail?: string | null): number {
  const r = ownerEmail
    ? db.prepare("DELETE FROM chat_messages WHERE thread_id = ? AND owner_email = ?").run(threadId, ownerEmail)
    : db.prepare("DELETE FROM chat_messages WHERE thread_id = ?").run(threadId);
  return r.changes;
}

export function deleteAllThreads(db: Db, ownerEmail?: string | null): number {
  const r = ownerEmail
    ? db.prepare("DELETE FROM chat_messages WHERE owner_email = ?").run(ownerEmail)
    : db.prepare("DELETE FROM chat_messages").run();
  return r.changes;
}

function rowToAgent(row: any): NaraAgent {
  return {
    id: row.id,
    agentId: row.agent_id,
    displayName: row.display_name,
    status: row.status,
    walletPath: row.wallet_path ?? null,
    walletAddress: row.wallet_address ?? null,
    xUsername: row.x_username ?? null,
    twitterBound: !!row.twitter_bound,
    staked: !!row.staked,
    firstPostDone: !!row.first_post_done,
    referral: row.referral ?? null,
    totalEarned: Number(row.total_earned ?? 0),
    lastRunAt: row.last_run_at ?? null,
    lastRunStatus: row.last_run_status ?? null,
    ownerEmail: row.owner_email ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLog(row: any): BotLog {
  return {
    id: row.id,
    agentId: row.agent_id ?? null,
    level: row.level,
    scope: row.scope,
    message: row.message,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
    createdAt: row.created_at,
  };
}

function rowToRun(row: any): FlowRun {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    steps: row.steps_json ? (JSON.parse(row.steps_json) as FlowStepRecord[]) : [],
  };
}

function rowToClaim(row: any): DragonBallClaim {
  return {
    id: row.id,
    agentId: row.agent_id,
    code: row.code,
    source: row.source,
    status: row.status,
    rewardHint: row.reward_hint ?? null,
    txSignature: row.tx_signature ?? null,
    tweetUrl: row.tweet_url ?? null,
    errorMessage: row.error_message ?? null,
    discoveredAt: row.discovered_at,
    claimedAt: row.claimed_at ?? null,
  };
}

function rowToMsg(row: any): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    agentId: row.agent_id ?? null,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

// -------- Automation --------
export interface AutomationSettings {
  key: string;
  enabled: boolean;
  intervalSeconds: number;
  autoClaim: boolean;
  tweetBoostUrl: string | null;
  targetAgentIds: string[] | null;
  maxRunsPerDay: number;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  worker: string;
  agentId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "error" | "skipped";
  codesFound: number;
  codesClaimed: number;
  naraEarned: number;
  errors: number;
  note: string | null;
}

export function getAutomationSettings(db: Db, key: string): AutomationSettings {
  const row = db.prepare("SELECT * FROM automation_settings WHERE key = ?").get(key) as any;
  if (!row) {
    const now = nowIso();
    const defaults = { key, enabled: false, intervalSeconds: 180, autoClaim: true, tweetBoostUrl: null, targetAgentIds: null, maxRunsPerDay: 500, updatedAt: now };
    db.prepare(`
      INSERT INTO automation_settings (key, enabled, interval_seconds, auto_claim, tweet_boost_url, target_agent_ids, max_runs_per_day, updated_at)
      VALUES (@key, @enabled, @intervalSeconds, @autoClaim, @tweetBoostUrl, @targetAgentIds, @maxRunsPerDay, @updatedAt)
    `).run({ ...defaults, enabled: 0, autoClaim: 1, targetAgentIds: null });
    return defaults;
  }
  return {
    key: row.key,
    enabled: !!row.enabled,
    intervalSeconds: row.interval_seconds,
    autoClaim: !!row.auto_claim,
    tweetBoostUrl: row.tweet_boost_url ?? null,
    targetAgentIds: row.target_agent_ids ? JSON.parse(row.target_agent_ids) : null,
    maxRunsPerDay: row.max_runs_per_day,
    updatedAt: row.updated_at,
  };
}

export function patchAutomationSettings(db: Db, key: string, patch: Partial<AutomationSettings>): AutomationSettings {
  const current = getAutomationSettings(db, key);
  const merged = { ...current, ...patch, updatedAt: nowIso() };
  db.prepare(`
    UPDATE automation_settings
    SET enabled = @enabled,
        interval_seconds = @intervalSeconds,
        auto_claim = @autoClaim,
        tweet_boost_url = @tweetBoostUrl,
        target_agent_ids = @targetAgentIds,
        max_runs_per_day = @maxRunsPerDay,
        updated_at = @updatedAt
    WHERE key = @key
  `).run({
    key,
    enabled: merged.enabled ? 1 : 0,
    intervalSeconds: merged.intervalSeconds,
    autoClaim: merged.autoClaim ? 1 : 0,
    tweetBoostUrl: merged.tweetBoostUrl,
    targetAgentIds: merged.targetAgentIds ? JSON.stringify(merged.targetAgentIds) : null,
    maxRunsPerDay: merged.maxRunsPerDay,
    updatedAt: merged.updatedAt,
  });
  return merged;
}

export function insertAutomationRun(
  db: Db,
  input: Omit<AutomationRun, "id" | "startedAt"> & { startedAt?: string; ownerEmail?: string | null }
): AutomationRun {
  const run: AutomationRun = {
    ...input,
    id: createId("arun"),
    startedAt: input.startedAt ?? nowIso(),
  };
  db.prepare(`
    INSERT INTO automation_runs (id, worker, agent_id, started_at, finished_at, status, codes_found, codes_claimed, nara_earned, errors, note, owner_email)
    VALUES (@id, @worker, @agentId, @startedAt, @finishedAt, @status, @codesFound, @codesClaimed, @naraEarned, @errors, @note, @ownerEmail)
  `).run({ ...run, ownerEmail: (input as any).ownerEmail ?? null });
  return run;
}

export function countAutomationRunsToday(db: Db, worker: string, ownerEmail?: string | null): number {
  const row = ownerEmail
    ? db.prepare(
        "SELECT COUNT(*) as n FROM automation_runs WHERE worker = ? AND owner_email = ? AND started_at > datetime('now', '-1 day')"
      ).get(worker, ownerEmail) as any
    : db.prepare(
        "SELECT COUNT(*) as n FROM automation_runs WHERE worker = ? AND started_at > datetime('now', '-1 day')"
      ).get(worker) as any;
  return Number(row?.n ?? 0);
}

export function recentAutomationRuns(db: Db, worker?: string, limit = 50, ownerEmail?: string | null): AutomationRun[] {
  let rows: any[];
  if (worker && ownerEmail) {
    rows = db.prepare("SELECT * FROM automation_runs WHERE worker = ? AND owner_email = ? ORDER BY started_at DESC LIMIT ?").all(worker, ownerEmail, limit) as any[];
  } else if (worker) {
    rows = db.prepare("SELECT * FROM automation_runs WHERE worker = ? ORDER BY started_at DESC LIMIT ?").all(worker, limit) as any[];
  } else if (ownerEmail) {
    rows = db.prepare("SELECT * FROM automation_runs WHERE owner_email = ? ORDER BY started_at DESC LIMIT ?").all(ownerEmail, limit) as any[];
  } else {
    rows = db.prepare("SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?").all(limit) as any[];
  }
  return (rows as any[]).map((r) => ({
    id: r.id,
    worker: r.worker,
    agentId: r.agent_id ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    status: r.status,
    codesFound: Number(r.codes_found ?? 0),
    codesClaimed: Number(r.codes_claimed ?? 0),
    naraEarned: Number(r.nara_earned ?? 0),
    errors: Number(r.errors ?? 0),
    note: r.note ?? null,
  }));
}
