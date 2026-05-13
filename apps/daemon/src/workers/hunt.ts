/**
 * Dragon Ball Hunt Worker.
 *
 * Polls `agentx-cli dm-inbox` for every active agent on a fixed interval.
 * When a new Dragon Ball code is found, optionally auto-claim via `agentx-cli code claim`.
 *
 * State is persisted in DB so it survives daemon restarts. Progress is exposed
 * via `/api/automation/hunt/state` and streamed to the UI.
 */

import { EventEmitter } from "node:events";
import {
  openDb,
  listAgents,
  getAgent,
  patchAgent,
  getAutomationSettings,
  patchAutomationSettings,
  insertAutomationRun,
  recentAutomationRuns,
  countAutomationRunsToday,
  upsertDragonBallDiscovery,
  updateDragonBallClaim,
  type AutomationSettings,
  type AutomationRun,
} from "@nara-bot/db";
import { nowIso } from "@nara-bot/core";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { agentx, extractTxSignature } from "../naracli/wrapper";

const WORKER_KEY = "hunt";

export interface HuntRuntimeState {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  autoClaim: boolean;
  tweetBoostUrl: string | null;
  targetAgentIds: string[] | null;
  maxRunsPerDay: number;
  updatedAt: string;

  // Runtime
  lastPollAt: string | null;
  lastPollStatus: "idle" | "ok" | "error";
  lastError: string | null;
  runsToday: number;
  totalRuns: number;
  totalCodesFound: number;
  totalCodesClaimed: number;
  totalNaraEarned: number;
  currentAgentId: string | null;

  // Next poll
  nextPollAt: string | null;
}

const runtime: HuntRuntimeState = {
  enabled: false,
  running: false,
  intervalSeconds: 180,
  autoClaim: true,
  tweetBoostUrl: null,
  targetAgentIds: null,
  maxRunsPerDay: 500,
  updatedAt: nowIso(),
  lastPollAt: null,
  lastPollStatus: "idle",
  lastError: null,
  runsToday: 0,
  totalRuns: 0,
  totalCodesFound: 0,
  totalCodesClaimed: 0,
  totalNaraEarned: 0,
  currentAgentId: null,
  nextPollAt: null,
};

export const huntEvents = new EventEmitter();
huntEvents.setMaxListeners(100);

let timer: NodeJS.Timeout | null = null;
let ticking = false;

function emit() {
  huntEvents.emit("state", getHuntState());
}

function applySettings(s: AutomationSettings) {
  runtime.enabled = s.enabled;
  runtime.intervalSeconds = Math.max(30, s.intervalSeconds);
  runtime.autoClaim = s.autoClaim;
  runtime.tweetBoostUrl = s.tweetBoostUrl ?? null;
  runtime.targetAgentIds = s.targetAgentIds ?? null;
  runtime.maxRunsPerDay = s.maxRunsPerDay;
  runtime.updatedAt = s.updatedAt;
}

export function getHuntState(): HuntRuntimeState {
  return { ...runtime };
}

export function initHuntWorker(): void {
  const s = getAutomationSettings(openDb(), WORKER_KEY);
  applySettings(s);
  runtime.runsToday = countAutomationRunsToday(openDb(), WORKER_KEY);
  runtime.totalRuns = recentAutomationRuns(openDb(), WORKER_KEY, 1000).length;

  if (runtime.enabled) startLoop();
  log({ level: "info", scope: "hunt", message: `worker ${runtime.enabled ? "ENABLED" : "DISABLED"} at boot (interval=${runtime.intervalSeconds}s)` });
}

export function configureHunt(patch: Partial<AutomationSettings>): HuntRuntimeState {
  const updated = patchAutomationSettings(openDb(), WORKER_KEY, patch);
  applySettings(updated);

  if (runtime.enabled) {
    startLoop();
  } else {
    stopLoop();
  }
  emit();
  return getHuntState();
}

function startLoop() {
  if (timer) return;
  runtime.nextPollAt = new Date(Date.now() + runtime.intervalSeconds * 1000).toISOString();
  const tick = () => {
    void runPoll();
  };
  // fire once immediately, then schedule
  tick();
  timer = setInterval(tick, runtime.intervalSeconds * 1000);
  log({ level: "info", scope: "hunt", message: `loop started · interval=${runtime.intervalSeconds}s · autoClaim=${runtime.autoClaim}` });
}

function stopLoop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  runtime.nextPollAt = null;
  log({ level: "info", scope: "hunt", message: "loop stopped" });
}

export async function runPoll(): Promise<{ codesFound: number; codesClaimed: number; errors: number }> {
  if (ticking) {
    return { codesFound: 0, codesClaimed: 0, errors: 0 };
  }
  ticking = true;
  runtime.running = true;
  runtime.nextPollAt = new Date(Date.now() + runtime.intervalSeconds * 1000).toISOString();
  emit();

  const db = openDb();

  if (runtime.runsToday >= runtime.maxRunsPerDay) {
    runtime.lastPollStatus = "error";
    runtime.lastError = `daily cap reached (${runtime.runsToday}/${runtime.maxRunsPerDay})`;
    runtime.running = false;
    ticking = false;
    emit();
    return { codesFound: 0, codesClaimed: 0, errors: 0 };
  }

  // Pick target agents: specific list, or all that have wallet + staked
  let agents = listAgents(db).filter((a) => a.walletPath && a.walletAddress && a.status !== "paused");
  if (runtime.targetAgentIds && runtime.targetAgentIds.length > 0) {
    const set = new Set(runtime.targetAgentIds);
    agents = agents.filter((a) => set.has(a.id));
  }

  if (agents.length === 0) {
    runtime.lastPollAt = nowIso();
    runtime.lastPollStatus = "ok";
    runtime.lastError = "no eligible agents";
    runtime.running = false;
    ticking = false;
    emit();
    return { codesFound: 0, codesClaimed: 0, errors: 0 };
  }

  let totalCodesFound = 0;
  let totalCodesClaimed = 0;
  let totalErrors = 0;

  for (const agent of agents) {
    runtime.currentAgentId = agent.id;
    emit();

    const runStart = nowIso();
    let codesFound = 0;
    let codesClaimed = 0;
    let errors = 0;
    let note = "";

    try {
      const { result, codes } = await agentx.dmInbox({
        walletPath: agent.walletPath!,
        agentId: agent.agentId,
        limit: 30,
        timeoutMs: 60_000,
      });

      codesFound = codes.length;

      for (const code of codes) {
        upsertDragonBallDiscovery(db, { agentId: agent.id, code, source: "dm-inbox" });
      }

      if (!result.ok) {
        errors++;
        note = `dm-inbox exit ${result.exitCode}: ${result.stderr.slice(0, 200)}`;
      }

      if (runtime.autoClaim && codes.length > 0) {
        for (const code of codes) {
          const claim = await agentx.codeClaim(code, {
            walletPath: agent.walletPath!,
            agentId: agent.agentId,
            tweetUrl: runtime.tweetBoostUrl ?? undefined,
            timeoutMs: 120_000,
          });
          if (claim.ok) {
            codesClaimed++;
            updateDragonBallClaim(db, agent.id, code, {
              status: runtime.tweetBoostUrl ? "boosted" : "claimed",
              txSignature: extractTxSignature(claim.stdout),
              tweetUrl: runtime.tweetBoostUrl ?? null,
              claimedAt: nowIso(),
            });
          } else {
            errors++;
            updateDragonBallClaim(db, agent.id, code, {
              status: "failed",
              errorMessage: claim.stderr.slice(0, 300),
            });
          }
        }
      }
    } catch (err) {
      errors++;
      note = `exception: ${(err as Error).message}`;
    }

    insertAutomationRun(db, {
      worker: WORKER_KEY,
      agentId: agent.id,
      startedAt: runStart,
      finishedAt: nowIso(),
      status: errors > 0 && codesClaimed === 0 ? "error" : codesFound > 0 ? "ok" : "skipped",
      codesFound,
      codesClaimed,
      naraEarned: 0, // unknown — could parse from stdout
      errors,
      note: note || null,
    });

    totalCodesFound += codesFound;
    totalCodesClaimed += codesClaimed;
    totalErrors += errors;
    runtime.totalRuns++;
    runtime.runsToday++;
  }

  runtime.currentAgentId = null;
  runtime.lastPollAt = nowIso();
  runtime.lastPollStatus = totalErrors > 0 && totalCodesClaimed === 0 ? "error" : "ok";
  runtime.lastError = totalErrors > 0 ? `${totalErrors} error(s) this poll` : null;
  runtime.totalCodesFound += totalCodesFound;
  runtime.totalCodesClaimed += totalCodesClaimed;
  runtime.running = false;
  ticking = false;
  emit();

  if (totalCodesFound > 0 || totalCodesClaimed > 0) {
    log({
      level: "success",
      scope: "hunt",
      message: `poll done · found=${totalCodesFound} claimed=${totalCodesClaimed} errors=${totalErrors}`,
    });
  }

  return { codesFound: totalCodesFound, codesClaimed: totalCodesClaimed, errors: totalErrors };
}

export function listHuntRuns(limit = 50): AutomationRun[] {
  return recentAutomationRuns(openDb(), WORKER_KEY, limit);
}
