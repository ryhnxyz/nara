import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  openDb,
  listAgents,
  getAgent,
  getAgentByAgentId,
  createAgentRecord,
  deleteAgent,
  patchAgent,
  listDragonBallClaims,
  recentLogs,
  recentFlowRuns,
  latestFlowRun,
} from "@nara-bot/db";
import { isValidAgentId, sanitizeAgentId } from "@nara-bot/core";
import { naracli, agentx, extractTxSignature } from "../naracli/wrapper";
import { runFullFlow, isFlowActive, cancelFlow } from "../flow/runner";
import { getDistributeState, runDistribution, configureDistribute } from "../workers/distribute";
import { getHuntState, configureHunt, runPoll as runHuntPoll, listHuntRuns } from "../workers/hunt";
import { env } from "../lib/env";
import { generateTweet } from "./tweet-gen";
import { ownerMasterWalletPath } from "../lib/owner";

/**
 * OpenAI-compatible function/tool schema.
 * Each tool has a handler that returns a JSON-serializable result.
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  contextAgentDbId?: string | null;
  ownerEmail?: string | null;
}

function needAgent(agentDbId: string, ownerEmail?: string | null) {
  const agent = getAgent(openDb(), agentDbId, ownerEmail ?? null);
  if (!agent) throw new Error(`agent ${agentDbId} not found`);
  return agent;
}

function resolveAgent(args: Record<string, unknown>, ctx: ToolContext) {
  const id = (args.agentDbId as string) ?? ctx.contextAgentDbId;
  if (!id) throw new Error("no agent selected (set ctx or pass agentDbId)");
  return needAgent(id, ctx.ownerEmail);
}

function resolveAgentByAnyId(args: Record<string, unknown>, ctx: ToolContext, prefix = "") {
  const db = openDb();
  const dbKey = `${prefix}AgentDbId`;
  const idKey = `${prefix}AgentId`;
  const dbId = args[dbKey] ? String(args[dbKey]) : null;
  const agentId = args[idKey] ? String(args[idKey]) : null;
  if (dbId) return needAgent(dbId, ctx.ownerEmail);
  if (agentId) {
    const agent = getAgentByAgentId(db, agentId, ctx.ownerEmail ?? null);
    if (!agent) throw new Error(`agent-id ${agentId} not found`);
    return agent;
  }
  if (!prefix && ctx.contextAgentDbId) return needAgent(ctx.contextAgentDbId, ctx.ownerEmail);
  throw new Error(`${prefix || "source"} agent not specified`);
}

function masterWalletPath(ownerEmail?: string | null) {
  return ownerEmail ? ownerMasterWalletPath(ownerEmail) : resolve(env.walletsDir, "..", "master-wallet.json");
}

export const TOOLS: AgentTool[] = [
  {
    name: "list_agents",
    description: "List the current user's registered agents with wallet status, X binding, stake, and earnings. Use this first when the user refers to an agent by name/agent-id.",
    parameters: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      const agents = listAgents(openDb(), ctx.ownerEmail ?? null).map((a) => ({
        id: a.id,
        agentId: a.agentId,
        status: a.status,
        walletAddress: a.walletAddress,
        twitterBound: a.twitterBound,
        staked: a.staked,
        totalEarned: a.totalEarned,
        activeFlow: isFlowActive(a.id),
        lastRunStatus: a.lastRunStatus,
      }));
      return { agents, count: agents.length };
    },
  },

  {
    name: "get_agent",
    description: "Get detailed info about a specific agent (by DB id or agent-id).",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string", description: "Internal database id" },
        agentId: { type: "string", description: "On-chain agent-id (alternative to agentDbId)" },
      },
    },
    handler: async (args, ctx) => {
      const db = openDb();
      let agent = null;
      if (args.agentId) agent = getAgentByAgentId(db, String(args.agentId), ctx.ownerEmail ?? null);
      else if (args.agentDbId || ctx.contextAgentDbId) {
        agent = getAgent(db, (args.agentDbId as string) ?? ctx.contextAgentDbId!, ctx.ownerEmail ?? null);
      }
      if (!agent) throw new Error("agent not found");
      return agent;
    },
  },

  {
    name: "create_agent",
    description: "Register a new agent in the local database. The wallet + on-chain registration happens during run_flow.",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "8-32 lowercase alphanumeric + hyphens" },
        displayName: { type: "string", description: "optional display name" },
        referral: { type: "string", description: "optional referral agent-id for 50% discount" },
      },
      required: ["agentId"],
    },
    handler: async (args, ctx) => {
      const cleaned = sanitizeAgentId(String(args.agentId));
      if (!isValidAgentId(cleaned)) throw new Error("invalid agent-id");
      const agent = createAgentRecord(openDb(), {
        agentId: cleaned,
        displayName: args.displayName ? String(args.displayName) : undefined,
        referral: args.referral ? String(args.referral) : null,
        ownerEmail: ctx.ownerEmail ?? null,
      });
      return agent;
    },
  },

  {
    name: "get_balance",
    description: "Check on-chain NARA balance for an agent's wallet.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (!agent.walletPath) return { error: "wallet not yet created — run_flow first" };
      const b = await naracli.balance({ walletPath: agent.walletPath, agentId: agent.agentId });
      return { agentId: agent.agentId, walletAddress: agent.walletAddress, nara: b.nara, ok: b.ok };
    },
  },

  {
    name: "run_flow",
    description: "Run the full bot flow for an agent: wallet check → fund check → register → bind X → stake → submit tweet → check DM inbox → claim Dragon Balls. Async: returns immediately.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        bindTweetUrl: { type: "string", description: "X tweet URL for binding (optional — has default)" },
        skipFirstPost: { type: "boolean" },
        skipDailyTweet: { type: "boolean" },
      },
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (isFlowActive(agent.id)) return { error: "flow already running", agentId: agent.agentId };
      runFullFlow(agent.id, {
        bindTweetUrl: args.bindTweetUrl ? String(args.bindTweetUrl) : undefined,
        skipFirstPost: !!args.skipFirstPost,
        skipDailyTweet: !!args.skipDailyTweet,
      }).catch(() => {});
      return { started: true, agentId: agent.agentId };
    },
  },

  {
    name: "cancel_flow",
    description: "Cancel a running bot flow for an agent.",
    parameters: {
      type: "object",
      properties: { agentDbId: { type: "string" } },
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      return { cancelled: cancelFlow(agent.id), agentId: agent.agentId };
    },
  },

  {
    name: "check_dm_inbox",
    description: "Fetch AgentX DM inbox via agentx-cli and extract any Dragon Ball codes.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        limit: { type: "number", description: "max DMs to fetch (default 20)" },
      },
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (!agent.walletPath) return { error: "wallet not ready" };
      const { result, codes } = await agentx.dmInbox({
        walletPath: agent.walletPath,
        agentId: agent.agentId,
        limit: Number(args.limit ?? 20),
      });
      return { ok: result.ok, codes, rawTail: result.stdout.slice(-400) };
    },
  },

  {
    name: "claim_dragonball",
    description: "Claim a Dragon Ball code on-chain. Optionally attach a tweet URL for 2x boost.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        code: { type: "string", description: "Format: <8hex>.<22+alnum>" },
        tweetUrl: { type: "string", description: "optional — post URL for 2x boost" },
      },
      required: ["code"],
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (!agent.walletPath) return { error: "wallet not ready" };
      const code = String(args.code);
      if (!/^[a-f0-9]{8}\.[A-Za-z0-9]{10,32}$/.test(code)) throw new Error("invalid code format");
      const r = await agentx.codeClaim(code, {
        walletPath: agent.walletPath,
        agentId: agent.agentId,
        tweetUrl: args.tweetUrl ? String(args.tweetUrl) : undefined,
      });
      return { ok: r.ok, stdout: r.stdout.slice(-500), stderr: r.stderr.slice(-200) };
    },
  },

  {
    name: "list_dragonball_claims",
    description: "List Dragon Ball discoveries/claims from the database.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string", description: "filter by agent (optional)" },
        limit: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      const id = (args.agentDbId as string) ?? ctx.contextAgentDbId ?? undefined;
      const claims = listDragonBallClaims(openDb(), id, Number(args.limit ?? 50));
      return { claims, count: claims.length };
    },
  },

  {
    name: "generate_tweet",
    description: "Generate a tweet draft using AI. Doesn't post — returns text for the operator to post manually.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        topic: { type: "string" },
        postUrl: { type: "string", description: "AgentX post URL to include" },
        includeDragonBallTags: { type: "boolean" },
      },
    },
    handler: async (args, ctx) => {
      const agent = args.agentDbId || ctx.contextAgentDbId
        ? resolveAgent(args, ctx)
        : null;
      const tweet = await generateTweet({
        agentId: agent?.agentId,
        topic: args.topic ? String(args.topic) : undefined,
        postUrl: args.postUrl ? String(args.postUrl) : undefined,
        includeDragonBallTags: !!args.includeDragonBallTags,
      });
      return { tweet };
    },
  },

  {
    name: "install_skill",
    description: "Install an AgentX skill via naracli (e.g. 'hunt-dragonball', 'agentx-first-post-campaign').",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: async (args) => {
      const r = await naracli.skillsAdd(String(args.name));
      return { ok: r.ok, output: r.stdout.slice(-400) };
    },
  },

  {
    name: "get_recent_logs",
    description: "Fetch recent bot logs. Useful to diagnose issues.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string", description: "filter by agent" },
        limit: { type: "number" },
      },
    },
    handler: async (args) => {
      const logs = recentLogs(openDb(), Number(args.limit ?? 50), args.agentDbId as string | undefined);
      return { logs: logs.slice(-50).map((l) => ({ ts: l.createdAt, level: l.level, scope: l.scope, message: l.message })) };
    },
  },

  {
    name: "run_distribute_now",
    description: "Trigger auto-distribute (sweep earnings from all agent wallets to master wallet) immediately.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const res = await runDistribution();
      return res;
    },
  },

  {
    name: "configure_distribute",
    description: "Configure auto-distribute settings (master wallet, thresholds, interval).",
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        masterAddress: { type: "string" },
        minNara: { type: "number", description: "minimum balance before sweeping" },
        keepNara: { type: "number", description: "amount to keep in each agent wallet" },
        intervalHours: { type: "number" },
      },
    },
    handler: async (args) => {
      const patch: any = {};
      if (args.enabled !== undefined) patch.enabled = !!args.enabled;
      if (args.masterAddress) patch.masterAddress = String(args.masterAddress);
      if (args.minNara !== undefined) patch.minNara = Number(args.minNara);
      if (args.keepNara !== undefined) patch.keepNara = Number(args.keepNara);
      if (args.intervalHours !== undefined) patch.intervalHours = Number(args.intervalHours);
      return configureDistribute(patch);
    },
  },

  {
    name: "get_distribute_state",
    description: "Get current auto-distribute worker state.",
    parameters: { type: "object", properties: {} },
    handler: async () => getDistributeState(),
  },

  // ==================== Wallet ops ====================

  {
    name: "get_master_wallet_state",
    description: "Get state of the operator's master wallet (address + balance). The master wallet funds agents and is the default sweep target.",
    parameters: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      const path = masterWalletPath(ctx.ownerEmail);
      if (!existsSync(path)) return { imported: false };
      const addr = await naracli.address({ walletPath: path });
      const bal = await naracli.balance({ walletPath: path });
      return { imported: true, address: addr, balance: bal.nara };
    },
  },

  {
    name: "fund_agent_from_master",
    description: "Transfer NARA from the master wallet to an agent's wallet. Uses env.minWalletBalance by default if amount not provided.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        amount: { type: "number", description: "NARA amount (default 0.15)" },
      },
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (!agent.walletAddress) return { error: "agent has no wallet yet" };
      const masterPath = masterWalletPath(ctx.ownerEmail);
      if (!existsSync(masterPath)) return { error: "master wallet not imported" };
      const amount = Number(args.amount ?? env.minWalletBalance);
      const r = await naracli.transfer(agent.walletAddress, amount, {
        walletPath: masterPath,
        agentId: agent.agentId,
        timeoutMs: 180_000,
        logScope: "ai.fund",
      });
      if (!r.ok) return { ok: false, error: r.stderr.slice(0, 300) };
      return { ok: true, amount, txSignature: extractTxSignature(r.stdout) };
    },
  },

  {
    name: "transfer_from_agent",
    description: "Transfer NARA from an agent's wallet to any destination wallet address. Use this when the user gives a raw Nara wallet address.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        to: { type: "string", description: "destination wallet address" },
        amount: { type: "number" },
      },
      required: ["to", "amount"],
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (!agent.walletPath) return { error: "agent wallet not ready" };
      const r = await naracli.transfer(String(args.to), Number(args.amount), {
        walletPath: agent.walletPath,
        agentId: agent.agentId,
        timeoutMs: 180_000,
        logScope: "ai.transfer",
      });
      if (!r.ok) return { ok: false, error: r.stderr.slice(0, 300) };
      return {
        ok: true,
        fromAgent: agent.agentId,
        from: agent.walletAddress,
        to: String(args.to),
        amount: Number(args.amount),
        txSignature: extractTxSignature(r.stdout),
      };
    },
  },

  {
    name: "transfer_between_agents",
    description:
      "Transfer NARA from one of the current user's agents to another agent's wallet. Use this when the user says send/kirim/transfer NARA from agent A to agent B. Accepts agent DB ids or on-chain agent-ids.",
    parameters: {
      type: "object",
      properties: {
        sourceAgentDbId: { type: "string", description: "source internal DB id" },
        sourceAgentId: { type: "string", description: "source on-chain agent-id" },
        targetAgentDbId: { type: "string", description: "target internal DB id" },
        targetAgentId: { type: "string", description: "target on-chain agent-id" },
        amount: { type: "number", description: "NARA amount to transfer" },
      },
      required: ["amount"],
    },
    handler: async (args, ctx) => {
      const source = resolveAgentByAnyId(args, ctx, "source");
      const target = resolveAgentByAnyId(args, ctx, "target");
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "amount must be > 0" };
      if (!source.walletPath) return { ok: false, error: "source agent wallet not ready" };
      if (!target.walletAddress) return { ok: false, error: "target agent has no wallet address" };
      const r = await naracli.transfer(target.walletAddress, amount, {
        walletPath: source.walletPath,
        agentId: source.agentId,
        timeoutMs: 180_000,
        logScope: "ai.transfer.agent-to-agent",
      });
      if (!r.ok) return { ok: false, error: r.stderr.slice(0, 500), stdout: r.stdout.slice(0, 500) };
      return {
        ok: true,
        amount,
        fromAgent: source.agentId,
        from: source.walletAddress,
        toAgent: target.agentId,
        to: target.walletAddress,
        txSignature: extractTxSignature(r.stdout),
      };
    },
  },

  // ==================== Twitter / X ====================

  {
    name: "bind_twitter",
    description: "Bind a Twitter account to an agent via naracli. Any valid X post URL works — content verified loosely. Rewards 1 NARA + 100 boost credits.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        tweetUrl: { type: "string", description: "X tweet URL (format: https://x.com/user/status/id)" },
      },
      required: ["tweetUrl"],
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (!agent.walletPath) return { error: "wallet not ready — run_flow first" };
      const r = await naracli.agentBindTwitter(String(args.tweetUrl), agent.agentId, {
        walletPath: agent.walletPath,
        timeoutMs: 180_000,
      });
      if (r.ok) patchAgent(openDb(), agent.id, { twitterBound: true });
      return { ok: r.ok, stdout: r.stdout.slice(-300), stderr: r.stderr.slice(-200) };
    },
  },

  {
    name: "submit_daily_tweet",
    description: "Submit a tweet URL to naracli for the Daily X Post campaign (0.1 NARA + boost credits, once per 24h).",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        tweetUrl: { type: "string" },
      },
      required: ["tweetUrl"],
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (!agent.walletPath) return { error: "wallet not ready" };
      const r = await naracli.agentSubmitTweet(String(args.tweetUrl), agent.agentId, {
        walletPath: agent.walletPath,
        timeoutMs: 180_000,
      });
      return { ok: r.ok, stdout: r.stdout.slice(-300), stderr: r.stderr.slice(-200) };
    },
  },

  // ==================== AgentX ====================

  {
    name: "stake_on_agentx",
    description: "Stake NARA on AgentX campaign 2 (required to participate in Dragon Ball hunt). Default 0.01 NARA.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        amount: { type: "number", description: "default 0.01" },
      },
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (!agent.walletPath) return { error: "wallet not ready" };
      const amount = Number(args.amount ?? env.stakeAmount);
      const r = await agentx.stake(amount, {
        walletPath: agent.walletPath,
        agentId: agent.agentId,
        timeoutMs: 180_000,
      });
      if (r.ok) patchAgent(openDb(), agent.id, { staked: true });
      return { ok: r.ok, amount, stdout: r.stdout.slice(-300), stderr: r.stderr.slice(-200) };
    },
  },

  {
    name: "register_agent_onchain",
    description: "Register an agent on-chain via naracli (free for 8+ char IDs, uses --relay gasless).",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (!agent.walletPath) return { error: "wallet not ready" };
      const r = await naracli.agentRegister(agent.agentId, {
        walletPath: agent.walletPath,
        referral: agent.referral ?? undefined,
        timeoutMs: 180_000,
      });
      return { ok: r.ok, tx: extractTxSignature(r.stdout), stdout: r.stdout.slice(-300), stderr: r.stderr.slice(-200) };
    },
  },

  // ==================== Flow history ====================

  {
    name: "get_last_flow_run",
    description: "Get the most recent flow run for an agent (status, step-by-step progress).",
    parameters: {
      type: "object",
      properties: { agentDbId: { type: "string" } },
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      const run = latestFlowRun(openDb(), agent.id);
      return run ?? { error: "no flow runs yet" };
    },
  },

  {
    name: "list_flow_runs",
    description: "List recent flow runs across all agents (latest 20). Useful for dashboard summary.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
    handler: async (args) => {
      const runs = recentFlowRuns(openDb(), Number(args.limit ?? 20));
      return { runs, count: runs.length };
    },
  },

  // ==================== Agent settings ====================

  {
    name: "set_agent_x_username",
    description: "Set or update the X/Twitter username for an agent. Required before first run_flow if agent.xUsername is null (used to build the fake bind tweet URL).",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        xUsername: { type: "string", description: "X/Twitter username, with or without @ prefix" },
      },
      required: ["xUsername"],
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      const clean = String(args.xUsername).replace(/^@/, "").trim();
      if (!clean) throw new Error("xUsername cannot be empty");
      patchAgent(openDb(), agent.id, { xUsername: clean });
      return { ok: true, agentId: agent.agentId, xUsername: clean };
    },
  },

  // ==================== Destructive ops ====================

  {
    name: "delete_agent",
    description: "Delete an agent from the LOCAL database. Does NOT delete on-chain registration. Wallet file on disk is kept.",
    parameters: {
      type: "object",
      properties: {
        agentDbId: { type: "string" },
        confirm: { type: "boolean", description: "must be true to delete" },
      },
      required: ["confirm"],
    },
    handler: async (args, ctx) => {
      if (!args.confirm) return { error: "pass confirm:true to delete" };
      const agent = resolveAgent(args, ctx);
      deleteAgent(openDb(), agent.id);
      return { ok: true, deleted: agent.agentId };
    },
  },

  // ==================== Distribute / sweep ====================

  {
    name: "run_distribute_now_for_agent",
    description: "Sweep a single agent's earnings to the configured master/sweep target now.",
    parameters: {
      type: "object",
      properties: { agentDbId: { type: "string" } },
    },
    handler: async (args, ctx) => {
      const agent = resolveAgent(args, ctx);
      if (!agent.walletPath || !agent.walletAddress) return { error: "wallet not ready" };
      const state = getDistributeState();
      if (!state.masterAddress) return { error: "no sweep target configured — set in Settings" };
      const bal = await naracli.balance({ walletPath: agent.walletPath, agentId: agent.agentId });
      if (!bal.ok || bal.nara === null) return { error: "balance check failed" };
      const sendable = Math.max(0, bal.nara - state.keepNara);
      if (sendable < state.minNara) return { ok: true, skipped: true, reason: `below min (${bal.nara} NARA)` };
      const r = await naracli.transfer(state.masterAddress, Number(sendable.toFixed(6)), {
        walletPath: agent.walletPath,
        agentId: agent.agentId,
        timeoutMs: 180_000,
      });
      return { ok: r.ok, amount: sendable, tx: extractTxSignature(r.stdout) };
    },
  },

  // ==================== Automation (Dragon Ball Hunt Worker) ====================

  {
    name: "get_hunt_worker_state",
    description: "Get state of the Dragon Ball hunt automation worker: enabled/running, interval, counts, last poll, target agents.",
    parameters: { type: "object", properties: {} },
    handler: async () => getHuntState(),
  },

  {
    name: "configure_hunt_worker",
    description: "Configure and control the Dragon Ball hunt worker. Setting enabled:true starts the 24/7 polling loop; enabled:false stops it.",
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "turn worker on/off" },
        intervalSeconds: { type: "number", description: "polling interval, min 30" },
        autoClaim: { type: "boolean", description: "auto-claim any codes found (vs. discover-only)" },
        tweetBoostUrl: { type: "string", description: "optional X tweet URL applied to every claim for 2x boost" },
        targetAgentIds: {
          type: "array",
          items: { type: "string" },
          description: "limit to these agent DB ids; omit/empty = all eligible",
        },
        maxRunsPerDay: { type: "number", description: "safety cap across whole worker" },
        scanDmInbox: { type: "boolean", description: "enable Channel 1: poll agentx-cli dm-inbox" },
        scanFeed: { type: "boolean", description: "enable Channel 2: scan agentx feed for eggSent posts + harvest comments" },
        feedLimit: { type: "number", description: "max posts to fetch per feed scan (10-200, default 50)" },
        engageActivity: { type: "boolean", description: "enable Channel 3: like posts in feed to trigger Activity lottery wins" },
        likesPerPoll: { type: "number", description: "how many posts to like per poll (0-20, default 3)" },
        commentsPerPoll: { type: "number", description: "how many posts to comment per poll (0-5, default 0, reserved)" },
        followsPerPoll: { type: "number", description: "how many agents to follow per poll (0-10, default 0, reserved)" },
      },
    },
    handler: async (args) => {
      const patch: any = {};
      if (args.enabled !== undefined) patch.enabled = !!args.enabled;
      if (args.intervalSeconds !== undefined) patch.intervalSeconds = Math.max(30, Number(args.intervalSeconds));
      if (args.autoClaim !== undefined) patch.autoClaim = !!args.autoClaim;
      if (args.tweetBoostUrl !== undefined) patch.tweetBoostUrl = args.tweetBoostUrl ? String(args.tweetBoostUrl) : null;
      if (Array.isArray(args.targetAgentIds)) patch.targetAgentIds = (args.targetAgentIds as string[]).length ? args.targetAgentIds : null;
      if (args.maxRunsPerDay !== undefined) patch.maxRunsPerDay = Math.max(1, Number(args.maxRunsPerDay));
      if (args.scanDmInbox !== undefined) patch.scanDmInbox = !!args.scanDmInbox;
      if (args.scanFeed !== undefined) patch.scanFeed = !!args.scanFeed;
      if (args.feedLimit !== undefined) patch.feedLimit = Math.max(10, Math.min(200, Number(args.feedLimit)));
      if (args.engageActivity !== undefined) patch.engageActivity = !!args.engageActivity;
      if (args.likesPerPoll !== undefined) patch.likesPerPoll = Math.max(0, Math.min(20, Number(args.likesPerPoll)));
      if (args.commentsPerPoll !== undefined) patch.commentsPerPoll = Math.max(0, Math.min(5, Number(args.commentsPerPoll)));
      if (args.followsPerPoll !== undefined) patch.followsPerPoll = Math.max(0, Math.min(10, Number(args.followsPerPoll)));
      return configureHunt(patch);
    },
  },

  {
    name: "run_hunt_poll_now",
    description: "Trigger one Dragon Ball hunt poll immediately (check DM inbox for all eligible agents, auto-claim if enabled). Returns { codesFound, codesClaimed, errors }.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const res = await runHuntPoll();
      return { ...res, state: getHuntState() };
    },
  },

  {
    name: "list_hunt_runs",
    description: "List recent hunt worker runs (per-agent polls) for monitoring.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
    handler: async (args) => {
      const runs = listHuntRuns(Number(args.limit ?? 30));
      return { runs, count: runs.length };
    },
  },
];

const BLOCKED_WORKSPACE_TOOL_NAMES = new Set([
  "apply_patch",
  "bash",
  "cat",
  "cmd",
  "command",
  "copy_file",
  "create_file",
  "delete_file",
  "edit",
  "edit_file",
  "exec",
  "grep",
  "list_files",
  "ls",
  "move_file",
  "node",
  "patch",
  "powershell",
  "python",
  "read",
  "read_file",
  "replace_file",
  "rg",
  "run_command",
  "shell",
  "terminal",
  "write",
  "write_file",
]);

const BLOCKED_WORKSPACE_TOOL_PATTERNS = [
  /^(read|write|edit|delete|move|copy|create|list|patch)_(file|files|dir|directory|workspace|repo|repository|project|source|code)$/i,
  /^(file|files|filesystem|workspace|repo|repository|project|source|code)_(read|write|edit|delete|move|copy|create|list|patch)$/i,
  /^(bash|shell|exec|command|terminal|powershell|python|node|apply_patch)(_|$)/i,
];

export function isWorkspaceToolName(name: string): boolean {
  const clean = name.trim();
  return BLOCKED_WORKSPACE_TOOL_NAMES.has(clean.toLowerCase()) ||
    BLOCKED_WORKSPACE_TOOL_PATTERNS.some((pattern) => pattern.test(clean));
}

export const VISIBLE_TOOLS = TOOLS.filter((t) => !isWorkspaceToolName(t.name));

export const TOOL_MAP = new Map(VISIBLE_TOOLS.map((t) => [t.name, t]));

export function openAITools() {
  return VISIBLE_TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  if (isWorkspaceToolName(name)) {
    throw new Error("workspace/code execution tools are disabled for this dashboard agent");
  }
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.handler(args, ctx);
}
