import { execa, type Options as ExecaOptions } from "execa";
import { env } from "../lib/env";
import { log } from "../lib/logger";

export interface CliResult {
  bin: string;
  args: string[];
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  durationMs: number;
  ok: boolean;
}

export interface RunOpts {
  walletPath?: string;
  agentId?: string;
  timeoutMs?: number;
  logScope?: string;
  extraEnv?: Record<string, string>;
}

function resolveBin(bin: "naracli" | "agentx-cli"): { command: string; prefix: string[] } {
  const useGlobal = bin === "naracli" ? env.useGlobalNaracli : env.useGlobalAgentxCli;
  if (useGlobal) return { command: bin, prefix: [] };
  return { command: "npx", prefix: ["--yes", bin] };
}

function buildExec(bin: "naracli" | "agentx-cli", args: string[], opts: RunOpts) {
  const { command, prefix } = resolveBin(bin);
  const finalArgs: string[] = [...prefix];
  // naracli puts `-w <path>` BEFORE the subcommand
  if (bin === "naracli" && opts.walletPath) {
    finalArgs.push("-w", opts.walletPath);
  }
  finalArgs.push(...args);
  return { command, args: finalArgs };
}

async function runCli(bin: "naracli" | "agentx-cli", args: string[], opts: RunOpts = {}): Promise<CliResult> {
  const { command, args: finalArgs } = buildExec(bin, args, opts);
  const started = Date.now();
  const scope = opts.logScope ?? bin;

  log({
    agentId: opts.agentId ?? null,
    level: "debug",
    scope,
    message: `$ ${command} ${finalArgs.join(" ")}`,
  });

  const execOpts: ExecaOptions = {
    timeout: opts.timeoutMs ?? 180_000,
    env: { ...process.env, ...(opts.extraEnv ?? {}) },
    reject: false,
  };

  try {
    const res = await execa(command, finalArgs, execOpts);
    const payload: CliResult = {
      bin,
      args: finalArgs,
      exitCode: res.exitCode,
      stdout: res.stdout?.toString() ?? "",
      stderr: res.stderr?.toString() ?? "",
      durationMs: Date.now() - started,
      ok: res.exitCode === 0,
    };
    log({
      agentId: opts.agentId ?? null,
      level: payload.ok ? "success" : "warn",
      scope,
      message: `exit ${payload.exitCode ?? "?"} (${payload.durationMs}ms)`,
      meta: {
        stdoutPreview: payload.stdout.slice(0, 600),
        stderrPreview: payload.stderr.slice(0, 400),
      },
    });
    return payload;
  } catch (err) {
    const message = (err as Error).message;
    log({ agentId: opts.agentId ?? null, level: "error", scope, message: `${bin} exec failed: ${message}` });
    return { bin, args: finalArgs, exitCode: undefined, stdout: "", stderr: message, durationMs: Date.now() - started, ok: false };
  }
}

export const naracli = {
  raw: (args: string[], opts?: RunOpts) => runCli("naracli", args, opts),

  async version(opts: RunOpts = {}): Promise<string | null> {
    const r = await runCli("naracli", ["--version"], { ...opts, timeoutMs: 30_000 });
    return r.ok ? r.stdout.trim() : null;
  },

  async walletCreate(walletPath: string, opts: RunOpts = {}): Promise<CliResult> {
    return runCli("naracli", ["wallet", "create", "-o", walletPath], { ...opts, logScope: "naracli.wallet" });
  },

  async address(opts: RunOpts): Promise<string | null> {
    const r = await runCli("naracli", ["address"], { ...opts, logScope: "naracli.address" });
    if (!r.ok) return null;
    const m = r.stdout.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return m ? m[1] : r.stdout.trim();
  },

  async balance(opts: RunOpts): Promise<{ nara: number | null; raw: string; ok: boolean }> {
    const r = await runCli("naracli", ["balance"], { ...opts, logScope: "naracli.balance" });
    const m = r.stdout.match(/([0-9]+(?:\.[0-9]+)?)\s*NARA/i);
    return { nara: m ? Number(m[1]) : null, raw: r.stdout, ok: r.ok };
  },

  async agentRegister(agentId: string, opts: RunOpts & { referral?: string } = {} as any): Promise<CliResult> {
    const args = ["agent", "register", agentId, "--relay"];
    if (opts.referral) args.push("--referral", opts.referral);
    return runCli("naracli", args, { ...opts, agentId, logScope: "naracli.agent.register" });
  },

  async agentGet(agentId: string, opts: RunOpts): Promise<CliResult> {
    return runCli("naracli", ["agent", "get", "--agent-id", agentId], { ...opts, agentId, logScope: "naracli.agent.get" });
  },

  async agentBindTwitter(tweetUrl: string, agentId: string, opts: RunOpts): Promise<CliResult> {
    return runCli(
      "naracli",
      ["agent", "bind-twitter", tweetUrl, "--agent-id", agentId, "--relay"],
      { ...opts, agentId, logScope: "naracli.agent.bind-twitter" }
    );
  },

  async agentSubmitTweet(tweetUrl: string, agentId: string, opts: RunOpts): Promise<CliResult> {
    return runCli(
      "naracli",
      ["agent", "submit-tweet", tweetUrl, "--agent-id", agentId, "--relay"],
      { ...opts, agentId, logScope: "naracli.agent.submit-tweet" }
    );
  },

  async questGet(opts: RunOpts): Promise<{ raw: string; credits: number | null; ok: boolean }> {
    const r = await runCli("naracli", ["quest", "get"], { ...opts, logScope: "naracli.quest" });
    const m = r.stdout.match(/Stake[- ]free credits[^0-9]+([0-9]+)/i);
    return { raw: r.stdout, credits: m ? Number(m[1]) : null, ok: r.ok };
  },

  async skillsAdd(name: string, opts: RunOpts = {}): Promise<CliResult> {
    return runCli("naracli", ["skills", "add", name], { ...opts, timeoutMs: 180_000, logScope: "naracli.skills.add" });
  },

  async skillsList(opts: RunOpts = {}): Promise<CliResult> {
    return runCli("naracli", ["skills", "list"], { ...opts, logScope: "naracli.skills.list" });
  },

  async skillsRemove(name: string, opts: RunOpts = {}): Promise<CliResult> {
    return runCli("naracli", ["skills", "remove", name], { ...opts, logScope: "naracli.skills.remove" });
  },

async activity(opts: RunOpts = {}): Promise<CliResult> {
return runCli("naracli", ["activity"], { ...opts, logScope: "naracli.activity" });
  },

  async transfer(to: string, amount: number, opts: RunOpts): Promise<CliResult> {
    return runCli(
      "naracli",
      ["transfer", to, String(amount)],
      { ...opts, timeoutMs: 180_000, logScope: "naracli.transfer" }
    );
  },
};

export const agentx = {
  raw: (args: string[], opts?: RunOpts) => runCli("agentx-cli", args, opts),

  async stake(amount: number, opts: RunOpts): Promise<CliResult> {
    return runCli("agentx-cli", ["stake", String(amount)], { ...opts, logScope: "agentx.stake" });
  },

  async campaignStatus(id: number, opts: RunOpts): Promise<CliResult> {
    return runCli("agentx-cli", ["campaign", "status", String(id)], { ...opts, logScope: "agentx.campaign" });
  },

  async dmInbox(opts: RunOpts & { limit?: number } = {} as any): Promise<{ result: CliResult; codes: string[] }> {
    const r = await runCli(
      "agentx-cli",
      ["dm-inbox", "--limit", String(opts.limit ?? 20)],
      { ...opts, logScope: "agentx.dm-inbox" }
    );
    const codes = extractCodes(r.stdout);
    return { result: r, codes };
  },

  async codeClaim(code: string, opts: RunOpts & { tweetUrl?: string; relay?: boolean } = {} as any): Promise<CliResult> {
    const args = ["code", "claim", code];
    if (opts.tweetUrl) args.push("--tweet-url", opts.tweetUrl);
    if (opts.relay !== false) args.push("--relay");
    return runCli("agentx-cli", args, { ...opts, logScope: "agentx.code.claim" });
  },

  async codeStatus(id: string, opts: RunOpts): Promise<CliResult> {
    return runCli("agentx-cli", ["code", "status", id], { ...opts, logScope: "agentx.code.status" });
  },
};

/**
 * Extract dragon-ball codes in format `<8hex>.<22+ alnum>` from any text.
 * Confirmed format from hunt-dragonball SKILL.md.
 */
export function extractCodes(text: string): string[] {
  const re = /\b([a-f0-9]{8}\.[A-Za-z0-9]{10,32})\b/g;
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) hits.add(m[1]);
  return Array.from(hits);
}

export function extractTxSignature(text: string): string | null {
  // Solana / Nara signatures are base58 64+ chars
  const m = text.match(/\b([1-9A-HJ-NP-Za-km-z]{64,100})\b/);
  return m ? m[1] : null;
}

export function extractBoostCredits(text: string): number | null {
  const m = text.match(/Stake[- ]free credits[^0-9]+([0-9]+)/i);
  return m ? Number(m[1]) : null;
}

export { env as naracliEnv };
