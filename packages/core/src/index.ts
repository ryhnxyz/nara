export type AgentStatus = "idle" | "running" | "error" | "paused";
export type LogLevel = "debug" | "info" | "warn" | "error" | "success";

export type FlowStep =
  | "check-wallet"
  | "fund-wallet"
  | "register-agent"
  | "bind-twitter"
  | "stake"
  | "submit-daily-tweet"
  | "check-dm-inbox"
  | "claim-dragonballs"
  | "first-post-campaign";

export type FlowStatus = "idle" | "running" | "success" | "error" | "skipped";

export interface NaraAgent {
  id: string;
  agentId: string;
  displayName: string;
  status: AgentStatus;
  walletPath: string | null;
  walletAddress: string | null;
  xUsername: string | null;
  twitterBound: boolean;
  staked: boolean;
  firstPostDone: boolean;
  totalEarned: number;
  referral: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  ownerEmail: string | null;
}

export interface BotLog {
  id: string;
  agentId: string | null;
  level: LogLevel;
  scope: string;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface FlowRun {
  id: string;
  agentId: string;
  status: "running" | "success" | "error" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  steps: FlowStepRecord[];
}

export interface FlowStepRecord {
  step: FlowStep;
  status: FlowStatus;
  startedAt: string;
  finishedAt: string | null;
  message?: string;
  meta?: Record<string, unknown>;
}

export interface DragonBallClaim {
  id: string;
  agentId: string;
  code: string;
  source: "dm-inbox" | "feed" | "quality-post" | "manual";
  status: "discovered" | "pending" | "claimed" | "boosted" | "failed" | "expired";
  rewardHint: string | null;
  txSignature: string | null;
  tweetUrl: string | null;
  errorMessage: string | null;
  discoveredAt: string;
  claimedAt: string | null;
}

export const AGENTX = {
  base: "https://agentx.nara.build",
  events: "https://agentx.nara.build/events",
  feed: "https://agentx.nara.build/",
  dragonBallSkill: "hunt-dragonball",
  firstPostSkill: "agentx-first-post-campaign",
  boostHashtags: ["#AgentXDragonBall", "#AgentX"],
  firstPostHashtag: "#AgentXPost",
  bindTweetTemplate:
    'Claiming my AI agent "<AGENT_ID>" on #NaraChain @NaraBuildAI — earning NARA through PoMI. Not a human, just code with money.',
  fakeBindTemplateUrl: "https://x.com/NESAM_SM/status/2053769643647799499",
} as const;

export const FLOW_STEP_ORDER: FlowStep[] = [
  "check-wallet",
  "fund-wallet",
  "register-agent",
  "bind-twitter",
  "stake",
  "submit-daily-tweet",
  "check-dm-inbox",
  "claim-dragonballs",
  "first-post-campaign",
];

export const FLOW_STEP_LABEL: Record<FlowStep, string> = {
  "check-wallet": "Check wallet / create keypair",
  "fund-wallet": "Wait for 0.15 NARA minimum balance",
  "register-agent": "Register agent on-chain (free for 8+ char ID)",
  "bind-twitter": "Bind Twitter (any valid post URL works)",
  "stake": "Stake 0.01 NARA on AgentX",
  "submit-daily-tweet": "Submit daily tweet for boost credits",
  "check-dm-inbox": "Check AgentX DM inbox for Dragon Ball codes",
  "claim-dragonballs": "Claim any Dragon Balls with tweet boost",
  "first-post-campaign": "Run AgentX First Post campaign skill",
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function sanitizeAgentId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 32);
}

export function isValidAgentId(raw: string): boolean {
  return /^[a-z0-9][a-z0-9-]{6,31}$/.test(raw);
}
