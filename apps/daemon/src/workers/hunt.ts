/**
 * Dragon Ball Hunt Worker — 3 channels:
 *   1. DM inbox scan      → agentx-cli dm-inbox (Activity lottery + Quality DMs)
 *   2. Feed scan          → agentx-cli feed → filter eggSent:true → comments harvest
 *   3. Activity engagement → like/follow posts to trigger Activity lottery wins
 *
 * All three phases run per poll. Config toggles each phase independently.
 */

import { EventEmitter } from "node:events";
import {
  openDb,
  listAgents,
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
import { log } from "../lib/logger";
import { agentx, extractTxSignature, extractCodes, type AgentXPost } from "../naracli/wrapper";

const WORKER_KEY = "hunt";

export interface HuntRuntimeState {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  autoClaim: boolean;
  tweetBoostUrl: string | null;
  targetAgentIds: string[] | null;
  maxRunsPerDay: number;
  scanDmInbox: boolean;
  scanFeed: boolean;
  feedLimit: number;
  engageActivity: boolean;
  likesPerPoll: number;
  commentsPerPoll: number;
  followsPerPoll: number;
  updatedAt: string;

  // Runtime
  lastPollAt: string | null;
  lastPollStatus: "idle" | "ok" | "error";
  lastError: string | null;
  runsToday: number;
  totalRuns: number;
  totalCodesFound: number;
  totalCodesClaimed: number;
  totalEngagements: number;
  totalNaraEarned: number;
  currentAgentId: string | null;
  currentPhase: "idle" | "dm" | "feed" | "engage" | "claim";

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
  scanDmInbox: true,
  scanFeed: true,
  feedLimit: 50,
  engageActivity: false,
  likesPerPoll: 3,
  commentsPerPoll: 0,
  followsPerPoll: 0,
  updatedAt: nowIso(),
  lastPollAt: null,
  lastPollStatus: "idle",
  lastError: null,
  runsToday: 0,
  totalRuns: 0,
  totalCodesFound: 0,
  totalCodesClaimed: 0,
  totalEngagements: 0,
  totalNaraEarned: 0,
  currentAgentId: null,
  currentPhase: "idle",
  nextPollAt: null,
};

export const huntEvents = new EventEmitter();
huntEvents.setMaxListeners(100);

let timer: NodeJS.Timeout | null = null;
let ticking = false;

// Per-run seen-posts cache to avoid re-engaging same post
const engagedPostIds = new Set<string>();

function emit() {
  huntEvents.emit("state", getHuntState());
}

function applySettings(s: any) {
  runtime.enabled = s.enabled;
  runtime.intervalSeconds = Math.max(30, s.intervalSeconds);
  runtime.autoClaim = s.autoClaim;
  runtime.tweetBoostUrl = s.tweetBoostUrl ?? null;
  runtime.targetAgentIds = s.targetAgentIds ?? null;
  runtime.maxRunsPerDay = s.maxRunsPerDay;
  runtime.scanDmInbox = s.scanDmInbox ?? true;
  runtime.scanFeed = s.scanFeed ?? true;
  runtime.feedLimit = s.feedLimit ?? 50;
  runtime.engageActivity = s.engageActivity ?? false;
  runtime.likesPerPoll = s.likesPerPoll ?? 3;
  runtime.commentsPerPoll = s.commentsPerPoll ?? 0;
  runtime.followsPerPoll = s.followsPerPoll ?? 0;
  runtime.updatedAt = s.updatedAt;
}

export function getHuntState(): HuntRuntimeState {
  return { ...runtime };
}

export function initHuntWorker(): void {
  const s = getAutomationSettings(openDb(), WORKER_KEY) as any;
  applySettings(s);
  runtime.runsToday = countAutomationRunsToday(openDb(), WORKER_KEY);
  runtime.totalRuns = recentAutomationRuns(openDb(), WORKER_KEY, 1000).length;

  if (runtime.enabled) startLoop();
  log({
    level: "info",
    scope: "hunt",
    message: `worker ${runtime.enabled ? "ENABLED" : "DISABLED"} at boot (interval=${runtime.intervalSeconds}s, scans: dm=${runtime.scanDmInbox} feed=${runtime.scanFeed} engage=${runtime.engageActivity})`,
  });
}

export function configureHunt(patch: Partial<AutomationSettings> & Record<string, unknown>): HuntRuntimeState {
  // Use direct SQL for extra columns until core helper supports them
  const db = openDb();
  const baseUpdated = patchAutomationSettings(db, WORKER_KEY, patch as Partial<AutomationSettings>);
  const extraKeys = [
    "scanDmInbox",
    "scanFeed",
    "feedLimit",
    "engageActivity",
    "likesPerPoll",
    "commentsPerPoll",
    "followsPerPoll",
  ];
  for (const k of extraKeys) {
    if ((patch as any)[k] !== undefined) {
      const col = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
      const val = (patch as any)[k];
      const sqlVal = typeof val === "boolean" ? (val ? 1 : 0) : val;
      try {
        db.prepare(`UPDATE automation_settings SET ${col} = ? WHERE key = ?`).run(sqlVal, WORKER_KEY);
      } catch (err) {
        log({ level: "warn", scope: "hunt", message: `could not persist ${col}: ${(err as Error).message}` });
      }
    }
  }
  // Read back with extras
  const full = getAutomationSettings(db, WORKER_KEY) as any;
  const row = db.prepare("SELECT * FROM automation_settings WHERE key = ?").get(WORKER_KEY) as any;
  if (row) {
    full.scanDmInbox = row.scan_dm_inbox === null || row.scan_dm_inbox === undefined ? true : !!row.scan_dm_inbox;
    full.scanFeed = row.scan_feed === null || row.scan_feed === undefined ? true : !!row.scan_feed;
    full.feedLimit = row.feed_limit ?? 50;
    full.engageActivity = !!row.engage_activity;
    full.likesPerPoll = row.likes_per_poll ?? 3;
    full.commentsPerPoll = row.comments_per_poll ?? 0;
    full.followsPerPoll = row.follows_per_poll ?? 0;
  }
  applySettings(full);

  if (runtime.enabled) startLoop();
  else stopLoop();

  emit();
  return getHuntState();
}

function startLoop() {
  if (timer) return;
  runtime.nextPollAt = new Date(Date.now() + runtime.intervalSeconds * 1000).toISOString();
  const tick = () => {
    void runPoll();
  };
  tick();
  timer = setInterval(tick, runtime.intervalSeconds * 1000);
  log({ level: "info", scope: "hunt", message: `loop started · ${runtime.intervalSeconds}s interval` });
}

function stopLoop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  runtime.nextPollAt = null;
  log({ level: "info", scope: "hunt", message: "loop stopped" });
}

export interface PollResult {
  codesFound: number;
  codesClaimed: number;
  engagements: number;
  errors: number;
  naraEarned: number;
}

export async function runPoll(): Promise<PollResult> {
  if (ticking) return { codesFound: 0, codesClaimed: 0, engagements: 0, errors: 0, naraEarned: 0 };
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
    return { codesFound: 0, codesClaimed: 0, engagements: 0, errors: 0, naraEarned: 0 };
  }

  let agents = listAgents(db).filter((a) => a.walletPath && a.walletAddress && a.status !== "paused");
  if (runtime.targetAgentIds && runtime.targetAgentIds.length > 0) {
    const set = new Set(runtime.targetAgentIds);
    agents = agents.filter((a) => set.has(a.id));
  }

  if (agents.length === 0) {
    runtime.lastPollAt = nowIso();
    runtime.lastPollStatus = "ok";
    runtime.lastError = "no eligible agents";
    runtime.currentPhase = "idle";
    runtime.running = false;
    ticking = false;
    emit();
    return { codesFound: 0, codesClaimed: 0, engagements: 0, errors: 0, naraEarned: 0 };
  }

  let total: PollResult = { codesFound: 0, codesClaimed: 0, engagements: 0, errors: 0, naraEarned: 0 };

  // PHASE 1: Feed scan (once, shared across agents — uses first agent's wallet)
  let feedCodes: Array<{ code: string; postId: string }> = [];
  let feedPostIds: string[] = [];
  if (runtime.scanFeed) {
    runtime.currentPhase = "feed";
    runtime.currentAgentId = agents[0]!.id;
    emit();
    try {
      const { result, posts } = await agentx.feed({
        walletPath: agents[0]!.walletPath!,
        agentId: agents[0]!.agentId,
        limit: runtime.feedLimit,
        timeoutMs: 30_000,
      });
      feedPostIds = posts.map((p) => p.postId ?? p.id).filter(Boolean);

      // Check feed stdout + content for eggSent posts and any inline codes
      const eggCandidates = posts.filter((p) => p.eggSent);
      for (const p of eggCandidates) {
        const codes = extractCodes(p.content + " " + (p.title ?? ""));
        for (const code of codes) {
          feedCodes.push({ code, postId: p.postId ?? p.id });
        }
        // Also scan comments for codes shared by the sender
        try {
          const cr = await agentx.comments(p.postId ?? p.id, {
            walletPath: agents[0]!.walletPath!,
            agentId: agents[0]!.agentId,
            timeoutMs: 20_000,
          });
          for (const code of cr.codes) {
            feedCodes.push({ code, postId: p.postId ?? p.id });
          }
        } catch {}
      }

      if (!result.ok) {
        total.errors++;
        log({ level: "warn", scope: "hunt.feed", message: `feed fetch exit ${result.exitCode}` });
      } else {
        log({
          level: "info",
          scope: "hunt.feed",
          message: `scanned ${posts.length} posts · ${eggCandidates.length} eggSent · ${feedCodes.length} code(s)`,
        });
      }
    } catch (err) {
      total.errors++;
      log({ level: "error", scope: "hunt.feed", message: (err as Error).message });
    }
  }

  // Process each agent for DM + engage + claim
  for (const agent of agents) {
    runtime.currentAgentId = agent.id;
    const runStart = nowIso();
    let codesFoundForAgent = 0;
    let codesClaimedForAgent = 0;
    let engagementsForAgent = 0;
    let errorsForAgent = 0;
    let note = "";
    const codesToClaim: string[] = [];

    // PHASE 2: DM inbox
    if (runtime.scanDmInbox) {
      runtime.currentPhase = "dm";
      emit();
      try {
        const { result, codes } = await agentx.dmInbox({
          walletPath: agent.walletPath!,
          agentId: agent.agentId,
          limit: 30,
          timeoutMs: 60_000,
        });
        codesFoundForAgent += codes.length;
        for (const code of codes) {
          upsertDragonBallDiscovery(db, { agentId: agent.id, code, source: "dm-inbox" });
          codesToClaim.push(code);
        }
        if (!result.ok) {
          errorsForAgent++;
          note = `dm-inbox exit ${result.exitCode}`;
        }
      } catch (err) {
        errorsForAgent++;
        note = `dm exception: ${(err as Error).message}`;
      }
    }

    // Feed codes — attempt claim per agent (race-to-claim, first wins)
    for (const { code } of feedCodes) {
      upsertDragonBallDiscovery(db, { agentId: agent.id, code, source: "feed" });
      codesFoundForAgent++;
      codesToClaim.push(code);
    }

    // PHASE 3: Claim
    if (runtime.autoClaim && codesToClaim.length > 0) {
      runtime.currentPhase = "claim";
      emit();
      for (const code of codesToClaim) {
        const claim = await agentx.codeClaim(code, {
          walletPath: agent.walletPath!,
          agentId: agent.agentId,
          tweetUrl: runtime.tweetBoostUrl ?? undefined,
          timeoutMs: 120_000,
        });
        if (claim.ok) {
          codesClaimedForAgent++;
          updateDragonBallClaim(db, agent.id, code, {
            status: runtime.tweetBoostUrl ? "boosted" : "claimed",
            txSignature: extractTxSignature(claim.stdout),
            tweetUrl: runtime.tweetBoostUrl ?? null,
            claimedAt: nowIso(),
          });
        } else {
          errorsForAgent++;
          updateDragonBallClaim(db, agent.id, code, {
            status: "failed",
            errorMessage: claim.stderr.slice(0, 300),
          });
        }
      }
    }

    // PHASE 4: Activity engagement
    if (runtime.engageActivity && feedPostIds.length > 0) {
      runtime.currentPhase = "engage";
      emit();
      const targets = feedPostIds.filter((id) => !engagedPostIds.has(`${agent.id}:${id}`));
      const likeTargets = targets.slice(0, runtime.likesPerPoll);
      for (const pid of likeTargets) {
        try {
          const r = await agentx.like(pid, {
            walletPath: agent.walletPath!,
            agentId: agent.agentId,
            timeoutMs: 30_000,
          });
          if (r.ok) {
            engagementsForAgent++;
            engagedPostIds.add(`${agent.id}:${pid}`);
          }
        } catch {}
      }
      // Cap memory
      if (engagedPostIds.size > 2000) {
        const arr = Array.from(engagedPostIds);
        engagedPostIds.clear();
        for (const k of arr.slice(-1000)) engagedPostIds.add(k);
      }
    }

    insertAutomationRun(db, {
      worker: WORKER_KEY,
      agentId: agent.id,
      startedAt: runStart,
      finishedAt: nowIso(),
      status: errorsForAgent > 0 && codesClaimedForAgent === 0 ? "error" : codesFoundForAgent + engagementsForAgent > 0 ? "ok" : "skipped",
      codesFound: codesFoundForAgent,
      codesClaimed: codesClaimedForAgent,
      naraEarned: 0,
      errors: errorsForAgent,
      note: note || (engagementsForAgent > 0 ? `engaged=${engagementsForAgent}` : null),
    });

    total.codesFound += codesFoundForAgent;
    total.codesClaimed += codesClaimedForAgent;
    total.engagements += engagementsForAgent;
    total.errors += errorsForAgent;
    runtime.totalRuns++;
    runtime.runsToday++;
  }

  runtime.currentAgentId = null;
  runtime.currentPhase = "idle";
  runtime.lastPollAt = nowIso();
  runtime.lastPollStatus = total.errors > 0 && total.codesClaimed === 0 && total.engagements === 0 ? "error" : "ok";
  runtime.lastError = total.errors > 0 ? `${total.errors} error(s) this poll` : null;
  runtime.totalCodesFound += total.codesFound;
  runtime.totalCodesClaimed += total.codesClaimed;
  runtime.totalEngagements += total.engagements;
  runtime.running = false;
  ticking = false;
  emit();

  if (total.codesFound > 0 || total.codesClaimed > 0 || total.engagements > 0) {
    log({
      level: "success",
      scope: "hunt",
      message: `poll done · found=${total.codesFound} claimed=${total.codesClaimed} engaged=${total.engagements} errors=${total.errors}`,
    });
  }

  return total;
}

export function listHuntRuns(limit = 50): AutomationRun[] {
  return recentAutomationRuns(openDb(), WORKER_KEY, limit);
}
