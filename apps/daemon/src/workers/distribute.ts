import { openDb, listAgents, patchAgent } from "@nara-bot/db";
import { nowIso } from "@nara-bot/core";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { naracli, extractTxSignature } from "../naracli/wrapper";

/**
 * Multi-tenant auto-distribute worker.
 *
 * Layout:
 *   - Per-user master wallets live under <walletsDir>/../master-wallets/<ownerSlug>.json
 *   - Legacy single-tenant master still honored at <walletsDir>/../master-wallet.json
 *
 * Each tick scans all master wallets present on disk, matches each to an
 * owner_email (via NaraAgent rows), and sweeps only that owner's agents to
 * that owner's master. Agents without owner_email still sweep to the legacy
 * master for backward compat.
 */

export interface DistributeState {
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "ok" | "error";
  lastError: string | null;
  transfers: number;
  naraSent: number;
  masterAddress: string;
  minNara: number;
  keepNara: number;
  intervalHours: number;
}

const state: DistributeState = {
  enabled: env.autoDistributeEnabled && !!env.masterWalletAddress,
  running: false,
  lastRunAt: null,
  lastRunStatus: "idle",
  lastError: null,
  transfers: 0,
  naraSent: 0,
  masterAddress: env.masterWalletAddress,
  minNara: env.autoDistributeMinNara,
  keepNara: env.autoDistributeKeepNara,
  intervalHours: env.autoDistributeIntervalHours,
};

let timer: NodeJS.Timeout | null = null;

export function getDistributeState(): DistributeState {
  return { ...state };
}

export function configureDistribute(
  patch: Partial<Pick<DistributeState, "enabled" | "masterAddress" | "minNara" | "keepNara" | "intervalHours">>,
): DistributeState {
  Object.assign(state, patch);
  if (state.enabled && !timer) startTimer();
  if (!state.enabled && timer) stopTimer();
  return getDistributeState();
}

function legacyMasterPath(): string {
  return resolve(env.walletsDir, "..", "master-wallet.json");
}

function perOwnerMastersDir(): string {
  return resolve(env.walletsDir, "..", "master-wallets");
}

/**
 * Discover all master-wallet files on disk.
 * Returns legacy path (if exists) + per-owner slug files.
 */
function discoverMasterWallets(): Array<{ path: string; ownerSlug: string | null }> {
  const found: Array<{ path: string; ownerSlug: string | null }> = [];
  const legacy = legacyMasterPath();
  if (existsSync(legacy)) found.push({ path: legacy, ownerSlug: null });
  const dir = perOwnerMastersDir();
  if (existsSync(dir)) {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const p = resolve(dir, name);
        try {
          if (!statSync(p).isFile()) continue;
        } catch {
          continue;
        }
        found.push({ path: p, ownerSlug: name.replace(/\.json$/, "") });
      }
    } catch {}
  }
  return found;
}

/**
 * Auto-enable sweep when at least one master wallet file exists.
 * Survives daemon restarts.
 */
export async function startDistributeWorker(): Promise<void> {
  const masters = discoverMasterWallets();
  if (masters.length > 0) {
    if (!state.masterAddress) {
      // Derive a display address from the first master for /distribute/state readability
      try {
        const addr = await naracli.address({ walletPath: masters[0]!.path });
        if (addr) state.masterAddress = addr;
      } catch {}
    }
    state.enabled = true;
    log({
      level: "info",
      scope: "distribute",
      message: `detected ${masters.length} master wallet(s) at boot → auto-enabled sweep`,
    });
  }
  if (state.enabled) startTimer();
}

/**
 * Called when master wallet is (re)imported by any user.
 */
export async function onMasterWalletImported(address: string): Promise<void> {
  state.masterAddress = address;
  state.enabled = true;
  state.lastError = null;
  log({ level: "success", scope: "distribute", message: `master wallet imported → sweep enabled (${address})` });
  if (!timer) startTimer();
}

/**
 * Called when master wallet is removed.
 * If there are still other master wallets on disk, keep sweep enabled.
 */
export function onMasterWalletRemoved(): void {
  const remaining = discoverMasterWallets();
  if (remaining.length === 0) {
    state.enabled = false;
    state.masterAddress = "";
    stopTimer();
    log({ level: "warn", scope: "distribute", message: "all master wallets removed → sweep disabled" });
  } else {
    log({
      level: "info",
      scope: "distribute",
      message: `master wallet removed; ${remaining.length} still active`,
    });
  }
}

function startTimer(): void {
  if (timer) return;
  const ms = Math.max(300_000, state.intervalHours * 3_600_000);
  log({
    level: "info",
    scope: "distribute",
    message: `auto-distribute ON → interval=${state.intervalHours}h`,
  });
  const tick = () =>
    runDistribution().catch((err) => {
      state.lastRunStatus = "error";
      state.lastError = (err as Error).message;
    });
  tick();
  timer = setInterval(tick, ms);
}

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
  log({ level: "info", scope: "distribute", message: "auto-distribute OFF" });
}

/**
 * One sweep pass across all owners.
 *
 * For each discovered master wallet:
 *   - Resolve its on-chain address
 *   - Pick agents: if ownerSlug, match by (owner_email → ownerSlug(email)); else pick agents with no owner_email (legacy)
 *   - Sweep each agent above threshold
 */
export async function runDistribution(): Promise<{ transfers: number; naraSent: number; errors: number }> {
  if (state.running) throw new Error("distribution already running");

  const masters = discoverMasterWallets();
  if (masters.length === 0) throw new Error("no master wallet files present");

  state.running = true;
  state.lastError = null;

  const { ownerSlug } = await import("../lib/owner");
  const db = openDb();
  const allAgents = listAgents(db).filter((a) => a.walletPath && a.walletAddress);

  let transfers = 0;
  let naraSent = 0;
  let errors = 0;

  for (const master of masters) {
    let masterAddr: string;
    try {
      const addr = await naracli.address({ walletPath: master.path });
      if (!addr) {
        errors++;
        log({ level: "warn", scope: "distribute", message: `could not resolve master address at ${master.path}` });
        continue;
      }
      masterAddr = addr;
    } catch (err) {
      errors++;
      log({ level: "error", scope: "distribute", message: `master address error: ${(err as Error).message}` });
      continue;
    }

    // Select agents for this master
    const scoped = allAgents.filter((a) => {
      if (master.ownerSlug) {
        const ownerEmail = (a as any).ownerEmail as string | null;
        return ownerEmail ? ownerSlug(ownerEmail) === master.ownerSlug : false;
      }
      // Legacy master handles all untagged agents
      return !((a as any).ownerEmail);
    });

    log({
      level: "info",
      scope: "distribute",
      message: `master=${masterAddr.slice(0, 10)}… agents=${scoped.length} (${master.ownerSlug ?? "legacy"})`,
    });

    for (const agent of scoped) {
      try {
        if (!agent.walletPath) continue;
        if (agent.walletAddress === masterAddr) continue;

        const bal = await naracli.balance({ walletPath: agent.walletPath, agentId: agent.agentId });
        if (!bal.ok || bal.nara === null) continue;
        if (bal.nara < state.minNara) continue;

        const sendable = Math.max(0, bal.nara - state.keepNara);
        if (sendable < state.minNara) continue;

        const amount = Number(sendable.toFixed(6));
        const r = await naracli.transfer(masterAddr, amount, {
          walletPath: agent.walletPath,
          agentId: agent.agentId,
        });
        if (r.ok) {
          transfers++;
          naraSent += amount;
          patchAgent(db, agent.id, { totalEarned: Number((agent.totalEarned ?? 0) + amount) });
          log({
            agentId: agent.id,
            level: "success",
            scope: "distribute",
            message: `swept ${amount} NARA → ${masterAddr.slice(0, 10)}…`,
            meta: { tx: extractTxSignature(r.stdout) },
          });
        } else {
          errors++;
          log({
            agentId: agent.id,
            level: "error",
            scope: "distribute",
            message: r.stderr.slice(0, 200) || "transfer failed",
          });
        }
      } catch (err) {
        errors++;
        log({ agentId: agent.id, level: "error", scope: "distribute", message: (err as Error).message });
      }
    }
  }

  state.transfers += transfers;
  state.naraSent += naraSent;
  state.lastRunAt = nowIso();
  state.lastRunStatus = errors > 0 && transfers === 0 ? "error" : "ok";
  state.running = false;

  log({
    level: transfers > 0 ? "success" : "info",
    scope: "distribute",
    message: `sweep done: transfers=${transfers} sent=${naraSent.toFixed(4)} errors=${errors} masters=${masters.length}`,
  });

  return { transfers, naraSent, errors };
}
