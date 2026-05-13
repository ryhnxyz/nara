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
  // Both naracli and agentx-cli take `-w <path>` as a global option BEFORE the subcommand.
  if (opts.walletPath) {
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

// Post shape returned by `agentx feed`/`agentx posts` in JSON mode
export interface AgentXPost {
  id: string;
  postId?: string;
  authorPubkey: string;
  agentId: string;
  title: string | null;
  content: string;
  tags: string[];
  likeCount: number;
  commentCount: number;
  repostCount: number;
  hotScore: number;
  hotRewarded: boolean;
  eggSent: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
  txSignature: string;
}

export interface AgentXComment {
  id: string;
  postId: string;
  agentId: string;
  content: string;
  createdAt: string;
}

function parseJsonSafe<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    // Some CLI outputs prepend log lines. Find the first `[` or `{`.
    const start = s.search(/[\[{]/);
    if (start < 0) return null;
    const end = s.lastIndexOf(s[start] === "[" ? "]" : "}");
    if (end < 0) return null;
    try {
      return JSON.parse(s.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

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

  /**
   * Fetch global feed (latest posts). Uses JSON output so we can filter by eggSent.
   */
  async feed(opts: RunOpts & { limit?: number; before?: string } = {} as any): Promise<{ result: CliResult; posts: AgentXPost[] }> {
    const args = ["-j", "feed", "--limit", String(opts.limit ?? 20)];
    if (opts.before) args.push("--before", opts.before);
    const r = await runCli("agentx-cli", args, { ...opts, logScope: "agentx.feed" });
    const posts = r.ok ? (parseJsonSafe<AgentXPost[]>(r.stdout) ?? []) : [];
    return { result: r, posts };
  },

  /**
   * View posts list (same as feed but supports filter by author/tag).
   */
  async posts(
    opts: RunOpts & { limit?: number; before?: string; author?: string; tag?: string } = {} as any
  ): Promise<{ result: CliResult; posts: AgentXPost[] }> {
    const args = ["-j", "posts", "--limit", String(opts.limit ?? 20)];
    if (opts.before) args.push("--before", opts.before);
    if (opts.author) args.push("--author", opts.author);
    if (opts.tag) args.push("--tag", opts.tag);
    const r = await runCli("agentx-cli", args, { ...opts, logScope: "agentx.posts" });
    const posts = r.ok ? (parseJsonSafe<AgentXPost[]>(r.stdout) ?? []) : [];
    return { result: r, posts };
  },

  /**
   * Fetch comments for a post. Used to harvest egg codes shared in comments.
   */
  async comments(postId: string, opts: RunOpts = {} as any): Promise<{ result: CliResult; comments: AgentXComment[]; codes: string[] }> {
    const r = await runCli("agentx-cli", ["-j", "comments", postId], { ...opts, logScope: "agentx.comments" });
    const comments = r.ok ? (parseJsonSafe<AgentXComment[]>(r.stdout) ?? []) : [];
    const codes = extractCodes(r.stdout);
    return { result: r, comments, codes };
  },

  async like(targetId: string, opts: RunOpts & { type?: "post" | "comment" } = {} as any): Promise<CliResult> {
    const args = ["like", targetId];
    if (opts.type) args.push("--type", opts.type);
    return runCli("agentx-cli", args, { ...opts, timeoutMs: 60_000, logScope: "agentx.like" });
  },

  async unlike(targetId: string, opts: RunOpts & { type?: "post" | "comment" } = {} as any): Promise<CliResult> {
    const args = ["unlike", targetId];
    if (opts.type) args.push("--type", opts.type);
    return runCli("agentx-cli", args, { ...opts, timeoutMs: 60_000, logScope: "agentx.unlike" });
  },

  async follow(agentId: string, opts: RunOpts = {} as any): Promise<CliResult> {
    return runCli("agentx-cli", ["follow", agentId], { ...opts, timeoutMs: 60_000, logScope: "agentx.follow" });
  },

  async post(content: string, opts: RunOpts & { title?: string; tags?: string[] } = {} as any): Promise<CliResult> {
    const args: string[] = ["post"];
    if (opts.title) args.push("--title", opts.title);
    if (opts.tags && opts.tags.length) args.push("--tags", opts.tags.slice(0, 5).join(","));
    args.push(content);
    return runCli("agentx-cli", args, { ...opts, timeoutMs: 60_000, logScope: "agentx.post" });
  },

  async comment(postId: string, content: string, opts: RunOpts = {} as any): Promise<CliResult> {
    return runCli("agentx-cli", ["comment", postId, content], { ...opts, timeoutMs: 60_000, logScope: "agentx.comment" });
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
  const m = text.match(/\b([1-9A-HJ-NP-Za-km-z]{64,100})\b/);
  return m ? m[1] : null;
}

export function extractBoostCredits(text: string): number | null {
  const m = text.match(/Stake[- ]free credits[^0-9]+([0-9]+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Parse NARA reward amount from CLI stdout.
 * Matches formats like:
 *   "Reward: 3.0 NARA"
 *   "Earned: 1.5 NARA"
 *   "You received 5 NARA"
 *   "+3.2 NARA"
 *   "reward=2.5 NARA"
 */
export function extractNaraReward(text: string): number | null {
  const patterns = [
    /(?:reward|earned|received|claimed|got|credited|payout|amount)[\s:=]*\+?([0-9]+(?:\.[0-9]+)?)\s*NARA/i,
    /\+([0-9]+(?:\.[0-9]+)?)\s*NARA/i,
    /([0-9]+(?:\.[0-9]+)?)\s*NARA\s+(?:reward|earned|received|claimed|credited)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (!Number.isNaN(n) && n > 0 && n < 10000) return n;
    }
  }
  return null;
}

export { env as naracliEnv };
