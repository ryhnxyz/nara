import { resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import {
  openDb,
  getAgent,
  patchAgent,
  startFlowRun,
  updateFlowRun,
  upsertDragonBallDiscovery,
  updateDragonBallClaim,
} from "@nara-bot/db";
import type { FlowRun, FlowStep, FlowStepRecord, NaraAgent } from "@nara-bot/core";
import { FLOW_STEP_ORDER, nowIso } from "@nara-bot/core";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { naracli, agentx, extractCodes, extractTxSignature } from "../naracli/wrapper";
import { generateTweet } from "../ai/tweet-gen";

export interface FlowOptions {
  /** X/Twitter username (without @) — required for first-time bind if agent.xUsername is null */
  xUsername?: string;
  /** Override the fake tweet URL entirely (bypasses username substitution) */
  bindTweetUrl?: string;
  /** Override daily tweet URL (default: reuse bind URL) */
  dailyTweetUrl?: string;
  tweetBoostAfterClaim?: boolean;
  skipFirstPost?: boolean;
  skipDailyTweet?: boolean;
}

/** Build the fake bind tweet URL from username + template. */
function buildTweetUrl(username: string, template: string): string {
  const clean = username.replace(/^@/, "").trim();
  // Replace existing username in template (between x.com/ and /status)
  return template.replace(/x\.com\/[^/]+\/status/, `x.com/${clean}/status`);
}

const active = new Map<string, AbortController>();

export function isFlowActive(agentId: string): boolean {
  return active.has(agentId);
}

export function cancelFlow(agentId: string): boolean {
  const ctrl = active.get(agentId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

export async function runFullFlow(agentDbId: string, opts: FlowOptions = {}): Promise<FlowRun> {
  const db = openDb();
  const agent = getAgent(db, agentDbId);
  if (!agent) throw new Error("agent not found");
  if (active.has(agent.id)) throw new Error("flow already running for this agent");

  const controller = new AbortController();
  active.set(agent.id, controller);

  const run = startFlowRun(db, agent.id);
  const steps: FlowStepRecord[] = [];

  patchAgent(db, agent.id, { status: "running", lastRunAt: nowIso(), lastRunStatus: "running" });

  const record = async (step: FlowStep, fn: () => Promise<{ status: FlowStepRecord["status"]; message?: string; meta?: any }>): Promise<FlowStepRecord> => {
    const startedAt = nowIso();
    steps.push({ step, status: "running", startedAt, finishedAt: null });
    updateFlowRun(db, run.id, { steps: [...steps] });
    log({ agentId: agent.id, level: "info", scope: `flow.${step}`, message: `▶ ${step}` });
    try {
      if (controller.signal.aborted) throw new Error("cancelled");
      const r = await fn();
      const record: FlowStepRecord = {
        step,
        status: r.status,
        startedAt,
        finishedAt: nowIso(),
        message: r.message,
        meta: r.meta,
      };
      steps[steps.length - 1] = record;
      updateFlowRun(db, run.id, { steps: [...steps] });
      log({
        agentId: agent.id,
        level: r.status === "success" ? "success" : r.status === "error" ? "error" : "info",
        scope: `flow.${step}`,
        message: `${r.status.toUpperCase()}: ${r.message ?? ""}`,
        meta: r.meta,
      });
      return record;
    } catch (err) {
      const message = (err as Error).message;
      const record: FlowStepRecord = {
        step,
        status: "error",
        startedAt,
        finishedAt: nowIso(),
        message,
      };
      steps[steps.length - 1] = record;
      updateFlowRun(db, run.id, { steps: [...steps] });
      log({ agentId: agent.id, level: "error", scope: `flow.${step}`, message });
      return record;
    }
  };

  const wallet = await ensureWalletFile(agent);
  patchAgent(db, agent.id, { walletPath: wallet.path });

  // Step 1: check-wallet
  const w = await record("check-wallet", async () => {
    if (!wallet.created && !wallet.existed) {
      return { status: "error", message: "could not create wallet file" };
    }
    const addr = await naracli.address({ walletPath: wallet.path, agentId: agent.agentId });
    if (!addr) return { status: "error", message: "address command failed" };
    patchAgent(db, agent.id, { walletAddress: addr });
    return { status: "success", message: `addr ${addr}`, meta: { address: addr, created: wallet.created } };
  });

  if (w.status !== "success") return finalize(agent.id, run, steps, "error");

  // Step 2: fund-wallet (check balance)
  const balance = await record("fund-wallet", async () => {
    const b = await naracli.balance({ walletPath: wallet.path, agentId: agent.agentId });
    if (!b.ok) return { status: "error", message: "balance command failed", meta: { raw: b.raw.slice(0, 200) } };
    if (b.nara === null) return { status: "error", message: "could not parse balance" };
    if (b.nara < env.minWalletBalance) {
      return {
        status: "error",
        message: `insufficient balance: ${b.nara} NARA (need ${env.minWalletBalance}). Fund address from faucet/exchange and retry.`,
        meta: { balance: b.nara },
      };
    }
    return { status: "success", message: `${b.nara} NARA`, meta: { balance: b.nara } };
  });
  if (balance.status !== "success") return finalize(agent.id, run, steps, "error");

  // Step 3: register-agent
  const reg = await record("register-agent", async () => {
    // check if already registered
    const getR = await naracli.agentGet(agent.agentId, { walletPath: wallet.path, agentId: agent.agentId, timeoutMs: 60_000 });
    if (getR.ok && !/not found|does not exist/i.test(getR.stdout + getR.stderr)) {
      return { status: "skipped", message: "already registered" };
    }
    const r = await naracli.agentRegister(agent.agentId, { walletPath: wallet.path, referral: agent.referral ?? undefined, timeoutMs: 180_000 });
    if (!r.ok) return { status: "error", message: r.stderr.slice(0, 200) || "register failed" };
    return { status: "success", message: "agent registered on-chain", meta: { tx: extractTxSignature(r.stdout) } };
  });
  if (reg.status === "error") return finalize(agent.id, run, steps, "error");

  // Step 4: bind-twitter — build URL from agent.xUsername + template. First-time bind requires username.
  const xUsername = opts.xUsername ?? agent.xUsername ?? null;
  let bindUrl: string;
  if (opts.bindTweetUrl) {
    bindUrl = opts.bindTweetUrl;
  } else if (xUsername) {
    bindUrl = buildTweetUrl(xUsername, env.defaultFakeBindTweetUrl);
  } else {
    bindUrl = env.defaultFakeBindTweetUrl; // fallback so we can still skip if already bound
  }

  const bindStep = await record("bind-twitter", async () => {
    if (agent.twitterBound) return { status: "skipped", message: `already bound (${agent.xUsername ?? "username not recorded"})` };
    if (!xUsername && !opts.bindTweetUrl) {
      return {
        status: "error",
        message: "xUsername required for first-time bind. Set opts.xUsername (e.g. 'NESAM_SM') or update agent.xUsername via PATCH /api/agents/:id before running flow.",
      };
    }
    const r = await naracli.agentBindTwitter(bindUrl, agent.agentId, { walletPath: wallet.path, timeoutMs: 180_000 });
    if (!r.ok) {
      const alreadyBound = /already|bound/i.test(r.stdout + r.stderr);
      if (alreadyBound) {
        patchAgent(db, agent.id, { twitterBound: true, xUsername: xUsername ?? agent.xUsername });
        return { status: "skipped", message: "already bound (upstream)" };
      }
      return { status: "error", message: r.stderr.slice(0, 200) || "bind-twitter failed" };
    }
    patchAgent(db, agent.id, { twitterBound: true, xUsername: xUsername ?? agent.xUsername });
    return { status: "success", message: `twitter bound as @${xUsername ?? "?"}`, meta: { tweet: bindUrl, xUsername } };
  });
  if (bindStep.status === "error") return finalize(agent.id, run, steps, "error");

  // Step 5: stake (via agentx-cli)
  const stakeStep = await record("stake", async () => {
    if (agent.staked) return { status: "skipped", message: "already staked" };
    const statusR = await agentx.campaignStatus(2, { walletPath: wallet.path, agentId: agent.agentId, timeoutMs: 60_000 });
    if (statusR.ok && /registered|claimed|not submitted/i.test(statusR.stdout)) {
      patchAgent(db, agent.id, { staked: true });
      return { status: "skipped", message: "already staked on campaign 2" };
    }
    const r = await agentx.stake(env.stakeAmount, { walletPath: wallet.path, agentId: agent.agentId, timeoutMs: 180_000 });
    if (!r.ok) {
      if (/already/i.test(r.stdout + r.stderr)) {
        patchAgent(db, agent.id, { staked: true });
        return { status: "skipped", message: "already staked" };
      }
      return { status: "error", message: r.stderr.slice(0, 200) || "stake failed" };
    }
    patchAgent(db, agent.id, { staked: true });
    return { status: "success", message: `staked ${env.stakeAmount} NARA` };
  });
  if (stakeStep.status === "error") return finalize(agent.id, run, steps, "error");

  // Step 6: submit-daily-tweet (optional)
  if (!opts.skipDailyTweet) {
    await record("submit-daily-tweet", async () => {
      const tweetUrl = opts.dailyTweetUrl || bindUrl;
      if (!tweetUrl) return { status: "skipped", message: "no tweet URL provided" };
      const r = await naracli.agentSubmitTweet(tweetUrl, agent.agentId, { walletPath: wallet.path, timeoutMs: 180_000 });
      if (!r.ok) {
        if (/already submitted|cooldown/i.test(r.stdout + r.stderr)) {
          return { status: "skipped", message: "already submitted today" };
        }
        return { status: "error", message: r.stderr.slice(0, 200) || "submit-tweet failed" };
      }
      return { status: "success", message: "daily tweet submitted" };
    });
  }

  // Step 7: check-dm-inbox → harvest codes
  const inbox = await record("check-dm-inbox", async () => {
    const { result, codes } = await agentx.dmInbox({ walletPath: wallet.path, agentId: agent.agentId, limit: 30, timeoutMs: 60_000 });
    for (const code of codes) {
      upsertDragonBallDiscovery(db, { agentId: agent.id, code, source: "dm-inbox" });
    }
    return {
      status: codes.length > 0 ? "success" : "skipped",
      message: codes.length > 0 ? `${codes.length} code(s) found` : "no codes in inbox",
      meta: { codes, rawTail: result.stdout.slice(-400) },
    };
  });

  // Step 8: claim-dragonballs
  await record("claim-dragonballs", async () => {
    const codes = (inbox.meta?.codes as string[] | undefined) ?? [];
    if (!codes.length) return { status: "skipped", message: "nothing to claim" };
    let claimed = 0;
    let failed = 0;
    for (const code of codes) {
      let tweetUrl: string | undefined;
      if (opts.tweetBoostAfterClaim !== false) {
        try {
          const postUrl = `${env.agentxBaseUrl}/post/${code.split(".")[0]}`;
          const tweetText = await generateTweet({
            agentId: agent.agentId,
            topic: `claiming Dragon Ball ${code.split(".")[0]} on AgentX`,
            postUrl,
            includeDragonBallTags: true,
          });
          log({
            agentId: agent.id,
            level: "info",
            scope: "flow.claim-dragonballs",
            message: `tweet draft for ${code}`,
            meta: { tweet: tweetText },
          });
          // We don't actually post to X — user pastes tweet URL, daemon uses it.
          tweetUrl = opts.dailyTweetUrl || env.defaultDailyTweetUrl || undefined;
        } catch {}
      }
      const r = await agentx.codeClaim(code, { walletPath: wallet.path, agentId: agent.agentId, tweetUrl, timeoutMs: 120_000 });
      if (r.ok) {
        claimed++;
        updateDragonBallClaim(db, agent.id, code, {
          status: tweetUrl ? "boosted" : "claimed",
          txSignature: extractTxSignature(r.stdout),
          tweetUrl: tweetUrl ?? null,
          claimedAt: nowIso(),
        });
      } else {
        failed++;
        updateDragonBallClaim(db, agent.id, code, {
          status: "failed",
          errorMessage: r.stderr.slice(0, 300) || r.stdout.slice(0, 300),
        });
      }
    }
    return {
      status: claimed > 0 ? "success" : failed > 0 ? "error" : "skipped",
      message: `claimed=${claimed} failed=${failed}`,
      meta: { claimed, failed },
    };
  });

  // Step 9: first-post-campaign — AgentX campaign id 0, requires a post and a tweet URL.
  // Done AFTER Dragon Ball claims because boost credits help on subsequent campaigns.
  if (!opts.skipFirstPost) {
    await record("first-post-campaign", async () => {
      if (agent.firstPostDone) return { status: "skipped", message: "already done" };
      // Check if already submitted
      const statusR = await agentx.campaignStatus(0, { walletPath: wallet.path, agentId: agent.agentId, timeoutMs: 60_000 });
      if (statusR.ok && /claimed|submitted/i.test(statusR.stdout)) {
        patchAgent(db, agent.id, { firstPostDone: true });
        return { status: "skipped", message: "already submitted/claimed" };
      }

      // Generate post content via AI
      let postContent = `Decentralized agents earning NARA through intelligence. #AgentX #NaraChain`;
      try {
        postContent = await generateTweet({
          agentId: agent.agentId,
          topic: "being a new AI agent on AgentX, plugging into the Nara chain economy",
          includeDragonBallTags: false,
        });
      } catch {}

      // 1. Create post on AgentX
      const postR = await agentx.post(postContent, { walletPath: wallet.path, agentId: agent.agentId, timeoutMs: 120_000 });
      if (!postR.ok) return { status: "error", message: `post failed: ${postR.stderr.slice(0, 200)}` };
      const postIdMatch = postR.stdout.match(/post[ _-]?id["':\s]*(\d{1,12})/i) || postR.stdout.match(/#(\d{3,})/);
      const postId = postIdMatch ? postIdMatch[1] : null;
      if (!postId) return { status: "error", message: "could not parse post id from stdout" };

      // 2. Submit campaign 0 with post ID + tweet URL (reuse bind tweet URL since #AgentXPost is required in tweet)
      const tweetUrl = opts.dailyTweetUrl || bindUrl;
      const submitR = await agentx.raw(
        ["campaign", "submit", "0", "--post-id", postId, "--tweet-url", tweetUrl, "--relay"],
        { walletPath: wallet.path, agentId: agent.agentId, timeoutMs: 180_000, logScope: "agentx.campaign.submit" }
      );
      if (!submitR.ok) {
        return { status: "error", message: submitR.stderr.slice(0, 200) || "campaign submit failed" };
      }
      patchAgent(db, agent.id, { firstPostDone: true });
      return {
        status: "success",
        message: `posted id=${postId} · submitted campaign 0 (10 NARA)`,
        meta: { postId, tx: extractTxSignature(submitR.stdout) },
      };
    });
  }

  return finalize(agent.id, run, steps, "success");
}

function finalize(
  agentDbId: string,
  run: FlowRun,
  steps: FlowStepRecord[],
  status: "success" | "error"
): FlowRun {
  const db = openDb();
  updateFlowRun(db, run.id, { steps, status, finishedAt: nowIso() });
  patchAgent(db, agentDbId, { status: "idle", lastRunAt: nowIso(), lastRunStatus: status });
  active.delete(agentDbId);
  return { ...run, steps, status, finishedAt: nowIso() };
}

interface WalletEnsure {
  path: string;
  existed: boolean;
  created: boolean;
}

async function ensureWalletFile(agent: NaraAgent): Promise<WalletEnsure> {
  mkdirSync(env.walletsDir, { recursive: true });
  const walletPath = agent.walletPath ?? resolve(env.walletsDir, `${agent.agentId}.json`);
  if (existsSync(walletPath)) {
    return { path: walletPath, existed: true, created: false };
  }
  const r = await naracli.walletCreate(walletPath, { agentId: agent.agentId });
  if (!r.ok) {
    log({
      agentId: agent.id,
      level: "error",
      scope: "wallet.create",
      message: r.stderr.slice(0, 200) || "wallet create failed",
    });
    return { path: walletPath, existed: false, created: false };
  }
  return { path: walletPath, existed: false, created: true };
}
