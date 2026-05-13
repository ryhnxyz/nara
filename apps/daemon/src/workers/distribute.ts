import { openDb, listAgents, patchAgent } from "@nara-bot/db";
import { nowIso } from "@nara-bot/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { naracli, extractTxSignature } from "../naracli/wrapper";


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

export function configureDistribute(patch: Partial<Pick<DistributeState, "enabled" | "masterAddress" | "minNara" | "keepNara" | "intervalHours">>): DistributeState {
  Object.assign(state, patch);
  if (state.enabled && state.masterAddress && !timer) startTimer();
  if ((!state.enabled || !state.masterAddress) && timer) stopTimer();
  return getDistributeState();
}

function masterWalletFilePath(): string {
  return resolve(env.walletsDir, "..", "master-wallet.json");
}

/**
 * Auto-enable sweep when master wallet file exists (imported).
  * This survives daemon restarts — if user imported master via /import,
 * sweep stays ON until master is removed.
 */
export async function startDistributeWorker(): Promise<void> {
  const path = masterWalletFilePath();
  const masterExists = existsSync(path);

  // If master wallet file exists but state has no address, auto-resolve it
  if (masterExists && !state.masterAddress) {
    try {
      const addr = await naracli.address({ walletPath: path });
      if (addr) {
        state.masterAddress = addr;
        state.enabled = true;
        log({ level: "info", scope: "distribute", message: `master wallet detected at boot → auto-enabled sweep (${addr})` });
      }
    } catch (err) {
      log({ level: "warn", scope: "distribute", message: `could not resolve master address at boot: ${(err as Error).message}` });
    }
  }

  if (state.enabled && state.masterAddress) startTimer();
}

/**
 * Called when master wallet is (re)imported — enables sweep automatically
 * and starts the timer loop.
 */
export async function onMasterWalletImported(address: string): Promise<void> {
  state.masterAddress = address;
  state.enabled = true;
  state.lastError = null;
  log({ level: "success", scope: "distribute", message: `master wallet imported → auto-enabling sweep (${address})` });
  if (!timer) startTimer();
}

/**
 * Called when master wallet is removed — disables sweep.
 */
export function onMasterWalletRemoved(): void {
  state.enabled = false;
  state.masterAddress = "";
  stopTimer();
  log({ level: "warn", scope: "distribute", message: "master wallet removed → sweep disabled" });
}

function startTimer(): void {
  if (timer) return;
  const ms = Math.max(300_000, state.intervalHours * 3_600_000);
  log({ level: "info", scope: "distribute", message: `auto-distribute ON → master=${state.masterAddress} interval=${state.intervalHours}h` });
  const tick = () => runDistribution().catch((err) => {
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

export async function runDistribution(): Promise<{ transfers: number; naraSent: number; errors: number }> {
  if (state.running) throw new Error("distribution already running");
  if (!state.masterAddress) throw new Error("master wallet address not configured");

  state.running = true;
  state.lastError = null;
  const db = openDb();
  const agents = listAgents(db).filter((a) => a.walletPath && a.walletAddress);

  log({ level: "info", scope: "distribute", message: `scanning ${agents.length} wallet(s) for sweep to ${state.masterAddress}` });

  let transfers = 0;
  let naraSent = 0;
  let errors = 0;

  for (const agent of agents) {
    try {
      if (!agent.walletPath) continue;
      if (agent.walletAddress === state.masterAddress) continue;

      const bal = await naracli.balance({ walletPath: agent.walletPath, agentId: agent.agentId });
      if (!bal.ok || bal.nara === null) continue;
      if (bal.nara < state.minNara) continue;

      const sendable = Math.max(0, bal.nara - state.keepNara);
      if (sendable < state.minNara) continue;

      const amount = Number(sendable.toFixed(6));
      const r = await naracli.transfer(state.masterAddress, amount, { walletPath: agent.walletPath, agentId: agent.agentId });
      if (r.ok) {
        transfers++;
        naraSent += amount;
        patchAgent(db, agent.id, { totalEarned: Number((agent.totalEarned ?? 0) + amount) });
        log({
          agentId: agent.id,
          level: "success",
          scope: "distribute",
          message: `swept ${amount} NARA → ${state.masterAddress.slice(0, 10)}…`,
          meta: { tx: extractTxSignature(r.stdout) },
        });
      } else {
        errors++;
        log({ agentId: agent.id, level: "error", scope: "distribute", message: r.stderr.slice(0, 200) || "transfer failed" });
      }
    } catch (err) {
      errors++;
      log({ agentId: agent.id, level: "error", scope: "distribute", message: (err as Error).message });
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
    message: `sweep done: transfers=${transfers} sent=${naraSent.toFixed(4)} errors=${errors}`,
  });

  return { transfers, naraSent, errors };
}
