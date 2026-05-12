import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadRootEnv() {
  const candidate = resolve(process.cwd(), "../../.env");
  if (existsSync(candidate)) {
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
    }
  }
}
loadRootEnv();

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined) return def;
  return /^(1|true|yes|on)$/i.test(v);
}

export const env = {
  port: Number(process.env.DAEMON_PORT ?? 4000),
  databasePath: process.env.DATABASE_PATH ?? "./data/nara-bot.db",
  encryptionKey: process.env.ENCRYPTION_KEY_HEX ?? "",

  // AI provider (opencode-compatible, OpenAI-compatible)
  aiBaseUrl: process.env.AI_BASE_URL ?? "http://62.146.236.107:8080/v1",
  aiApiKey: process.env.AI_API_KEY ?? "",
  aiModel: process.env.AI_MODEL ?? "kiro/claude-opus-4.7",
  aiTweetModel: process.env.AI_TWEET_MODEL ?? "kiro/claude-opus-4.7",

  // Nara CLIs
  useGlobalNaracli: bool(process.env.USE_GLOBAL_NARACLI, false),
  useGlobalAgentxCli: bool(process.env.USE_GLOBAL_AGENTXCLI, false),
  naracliBin: process.env.NARACLI_BIN ?? "naracli",
  agentxCliBin: process.env.AGENTX_CLI_BIN ?? "agentx-cli",

  // Flow defaults
  dragonBallPollSeconds: Number(process.env.DRAGONBALL_POLL_SECONDS ?? 60),
  stakeAmount: Number(process.env.STAKE_AMOUNT ?? 0.01),
  minWalletBalance: Number(process.env.MIN_WALLET_BALANCE ?? 0.15),
  walletsDir: process.env.WALLETS_DIR ?? resolve(process.cwd(), "../../data/wallets"),

  // Auto-distribute earnings
  masterWalletAddress: process.env.MASTER_WALLET_ADDRESS ?? "",
  autoDistributeEnabled: bool(process.env.AUTO_DISTRIBUTE_ENABLED, false),
  autoDistributeMinNara: Number(process.env.AUTO_DISTRIBUTE_MIN_NARA ?? 0.5),
  autoDistributeKeepNara: Number(process.env.AUTO_DISTRIBUTE_KEEP_NARA ?? 0.05),
  autoDistributeIntervalHours: Number(process.env.AUTO_DISTRIBUTE_INTERVAL_HOURS ?? 6),

  // AgentX
  agentxBaseUrl: process.env.AGENTX_BASE_URL ?? "https://agentx.nara.build",

  // Bot flow defaults
  defaultFakeBindTweetUrl: process.env.FAKE_BIND_TWEET_URL ?? "https://x.com/NESAM_SM/status/2053769643647799499",
  defaultDailyTweetUrl: process.env.DEFAULT_DAILY_TWEET_URL ?? "",
};
