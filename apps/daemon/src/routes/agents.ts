import { Hono } from "hono";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAgentRecord,
  deleteAgent,
  getAgent,
  listAgents,
  openDb,
  patchAgent,
  latestFlowRun,
} from "@nara-bot/db";
import { isValidAgentId, sanitizeAgentId } from "@nara-bot/core";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { cancelFlow, isFlowActive, runFullFlow } from "../flow/runner";
import { naracli, extractTxSignature } from "../naracli/wrapper";
import { ownerFromContext, ownerWalletsDir, ownerMasterWalletPath } from "../lib/owner";

export const agentsRoute = new Hono();

function masterWalletPath(owner: string | null): string {
  if (owner) return ownerMasterWalletPath(owner);
  return resolve(env.walletsDir, "..", "master-wallet.json");
}

function agentWalletPath(owner: string | null, agentId: string): string {
  const dir = owner ? ownerWalletsDir(owner) : env.walletsDir;
  return resolve(dir, `${agentId}.json`);
}

agentsRoute.get("/", (c) => {
  const owner = ownerFromContext(c);
  const db = openDb();
  const agents = listAgents(db, owner).map((a) => ({
    ...a,
    activeFlow: isFlowActive(a.id),
    lastRun: latestFlowRun(db, a.id),
  }));
  return c.json({ agents });
});

/**
 * POST /api/agents
 * Body: { agentId, displayName?, referral?, autoCreateWallet? }
 *
 * If autoCreateWallet=true (default), also creates the wallet file immediately
 * and returns the new wallet address so the frontend can fund it.
 */
agentsRoute.post("/", async (c) => {
  const body = await c.req.json<{
    agentId: string;
    displayName?: string;
    referral?: string;
    autoCreateWallet?: boolean;
  }>();
  const cleaned = sanitizeAgentId(body.agentId ?? "");
  if (!isValidAgentId(cleaned)) {
    return c.json({ error: "agent-id must be 7-32 chars, lowercase alphanumeric + hyphens" }, 400);
  }

  const owner = ownerFromContext(c);
  const db = openDb();
  let agent;
  try {
    agent = createAgentRecord(db, {
      agentId: cleaned,
      displayName: body.displayName,
      referral: body.referral ?? null,
      ownerEmail: owner,
    });
    log({ agentId: agent.id, level: "success", scope: "agents", message: `created ${agent.agentId}${owner ? ` for ${owner}` : ""}` });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("UNIQUE")) return c.json({ error: "agent-id already exists locally" }, 409);
    return c.json({ error: msg }, 500);
  }

  // Auto-create wallet by default so user immediately sees address to fund
  if (body.autoCreateWallet !== false) {
    try {
      const walletsDir = owner ? (await import("../lib/owner")).ownerWalletsDir(owner) : env.walletsDir;
      mkdirSync(walletsDir, { recursive: true });
      const wpath = agentWalletPath(owner, cleaned);
      if (!existsSync(wpath)) {
        const r = await naracli.walletCreate(wpath, { agentId: cleaned, timeoutMs: 60_000 });
        if (!r.ok) {
          log({ agentId: agent.id, level: "warn", scope: "agents", message: `wallet create failed: ${r.stderr.slice(0, 200)}` });
        }
      }
      if (existsSync(wpath)) {
        const addr = await naracli.address({ walletPath: wpath, agentId: cleaned });
        if (addr) {
          patchAgent(db, agent.id, { walletPath: wpath, walletAddress: addr });
          agent = { ...agent, walletPath: wpath, walletAddress: addr };
          log({ agentId: agent.id, level: "success", scope: "agents", message: `wallet ready: ${addr}` });
        }
      }
    } catch (err) {
      log({ agentId: agent.id, level: "error", scope: "agents", message: `wallet init failed: ${(err as Error).message}` });
    }
  }

  return c.json({ agent }, 201);
});

agentsRoute.get("/:id", (c) => {
  const owner = ownerFromContext(c);
  const db = openDb();
  const agent = getAgent(db, c.req.param("id"), owner);
  if (!agent) return c.json({ error: "not found" }, 404);
  return c.json({ agent, lastRun: latestFlowRun(db, agent.id), activeFlow: isFlowActive(agent.id) });
});

agentsRoute.patch("/:id", async (c) => {
  const owner = ownerFromContext(c);
  const db = openDb();
  const existing = getAgent(db, c.req.param("id"), owner);
  if (!existing) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  patchAgent(db, c.req.param("id"), body as any);
  return c.json({ ok: true });
});

agentsRoute.delete("/:id", (c) => {
  const owner = ownerFromContext(c);
  const db = openDb();
  const existing = getAgent(db, c.req.param("id"), owner);
  if (!existing) return c.json({ error: "not found" }, 404);
  deleteAgent(db, c.req.param("id"));
  return c.json({ ok: true });
});

/**
 * GET /api/agents/:id/export
 * Export wallet keypair for an agent. Returns:
 *   - privateKey (base58) — single-line, ready to paste
 *   - publicKey (address)
 *   - keypairJson — raw Solana-style [byte,byte,...] array
 *
 * SECURITY: This returns SECRETS. Client MUST warn user before displaying.
 * Only available to authenticated dashboard operator (single-user mode for now).
 */
agentsRoute.get("/:id/export", async (c) => {
  const owner = ownerFromContext(c);
  const db = openDb();
  const agent = getAgent(db, c.req.param("id"), owner);
  if (!agent) return c.json({ error: "agent not found" }, 404);
  if (!agent.walletPath) return c.json({ error: "wallet not yet created" }, 400);
  if (!existsSync(agent.walletPath)) return c.json({ error: "wallet file missing on disk" }, 410);

  try {
    const raw = (await import("node:fs")).readFileSync(agent.walletPath, "utf8");
    const bytes = JSON.parse(raw) as number[];
    if (!Array.isArray(bytes) || bytes.length !== 64) {
      return c.json({ error: "unexpected wallet format" }, 500);
    }
    const secretKey = new Uint8Array(bytes);
    // base58 encode the full 64-byte secret key — standard export format used by phantom/solflare
    const { default: bs58 } = await import("bs58");
    const privateKey = bs58.encode(secretKey);
    const publicKey = agent.walletAddress ?? "unknown";

    log({
      agentId: agent.id,
      level: "warn",
      scope: "agents.export",
      message: `Wallet exported for ${agent.agentId} (operator action)`,
    });

    return c.json({
      agentId: agent.agentId,
      publicKey,
      privateKey,
      keypairJson: bytes,
      warning: "KEEP THIS SECRET. Anyone with this key can drain the wallet.",
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /api/agents/:id/fund-from-master
 * Transfer from the master wallet to this agent's wallet.
 * Body: { amount?: number }  default = env.minWalletBalance
 */
agentsRoute.post("/:id/fund-from-master", async (c) => {
  const owner = ownerFromContext(c);
  const db = openDb();
  const agent = getAgent(db, c.req.param("id"), owner);
  if (!agent) return c.json({ error: "agent not found" }, 404);
  if (!agent.walletAddress) return c.json({ error: "agent has no wallet yet" }, 400);

  const masterPath = masterWalletPath(owner);
  if (!existsSync(masterPath)) return c.json({ error: "master wallet not imported (go to Settings)" }, 400);

  const body = await c.req.json<{ amount?: number }>().catch(() => ({} as { amount?: number }));
  const amount = body.amount ?? env.minWalletBalance;

  const r = await naracli.transfer(agent.walletAddress, amount, {
    walletPath: masterPath,
    agentId: agent.agentId,
    timeoutMs: 180_000,
    logScope: "agents.fund-from-master",
  });
  if (!r.ok) return c.json({ error: r.stderr.slice(0, 300) || "transfer failed" }, 500);

  const tx = extractTxSignature(r.stdout);
  log({
    agentId: agent.id,
    level: "success",
    scope: "agents.fund",
    message: `Funded ${agent.agentId} with ${amount} NARA`,
    meta: { tx, to: agent.walletAddress },
  });
  return c.json({ ok: true, txSignature: tx, amount, to: agent.walletAddress });
});

/**
 * POST /api/agents/:id/run
 * Run the bot flow for this agent.
 * Body supports autoFundFromMaster:true which funds before flow if balance < min.
 */
agentsRoute.post("/:id/run", async (c) => {
  const owner = ownerFromContext(c);
  const id = c.req.param("id");
  type RunBody = {
    xUsername?: string;
    bindTweetUrl?: string;
    dailyTweetUrl?: string;
    tweetBoostAfterClaim?: boolean;
    skipFirstPost?: boolean;
    skipDailyTweet?: boolean;
    autoFundFromMaster?: boolean;
    fundAmount?: number;
  };
  const body = (await c.req.json<RunBody>().catch(() => ({}))) as RunBody;

  if (isFlowActive(id)) return c.json({ error: "flow already running" }, 409);

  const db = openDb();
  const agent = getAgent(db, id, owner);
  if (!agent) return c.json({ error: "agent not found" }, 404);

  // Pre-flow: auto-fund if requested and master wallet exists and agent has address
  if (body.autoFundFromMaster && agent.walletAddress) {
    const masterPath = masterWalletPath(owner);
    if (existsSync(masterPath)) {
      try {
        const currentBal = await naracli.balance({ walletPath: agent.walletPath ?? "", agentId: agent.agentId });
        if (currentBal.nara === null || currentBal.nara < env.minWalletBalance) {
          const amount = body.fundAmount ?? env.minWalletBalance;
          log({ agentId: agent.id, level: "info", scope: "agents.fund", message: `Auto-funding ${amount} NARA before flow` });
          const r = await naracli.transfer(agent.walletAddress, amount, {
            walletPath: masterPath,
            agentId: agent.agentId,
            timeoutMs: 180_000,
            logScope: "agents.fund-from-master",
          });
          if (r.ok) {
            log({ agentId: agent.id, level: "success", scope: "agents.fund", message: `Pre-funded ${amount} NARA ✓` });
          } else {
            log({ agentId: agent.id, level: "warn", scope: "agents.fund", message: `Auto-fund failed: ${r.stderr.slice(0, 200)}` });
          }
        }
      } catch (err) {
        log({ agentId: agent.id, level: "warn", scope: "agents.fund", message: `Auto-fund error: ${(err as Error).message}` });
      }
    } else {
      log({ agentId: agent.id, level: "warn", scope: "agents.fund", message: "autoFundFromMaster requested but no master wallet imported" });
    }
  }

  runFullFlow(id, body).catch((err) => {
    log({ agentId: id, level: "error", scope: "flow", message: `flow crashed: ${(err as Error).message}` });
  });
  return c.json({ ok: true, started: true });
});

agentsRoute.post("/:id/cancel", (c) => {
  const owner = ownerFromContext(c);
  const db = openDb();
  const existing = getAgent(db, c.req.param("id"), owner);
  if (!existing) return c.json({ error: "not found" }, 404);
  const ok = cancelFlow(c.req.param("id"));
  return c.json({ ok });
});
