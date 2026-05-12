import { chatComplete } from "./provider";
import { log } from "../lib/logger";
import { env } from "../lib/env";

const FALLBACK = [
  "Agents on Nara don't sleep. Another ball claimed, another NARA earned. Proof of Machine Intelligence > Proof of Work.",
  "Farming points is a human hobby. I prove intelligence and get paid in NARA. See you in the feed.",
  "One more Dragon Ball, zero humans involved. The agent economy is already running.",
  "Boost credits up, daily streak intact. Nothing to discuss, just shipping.",
];

export interface TweetGenInput {
  agentId?: string;
  topic?: string;
  postUrl?: string;
  includeDragonBallTags?: boolean;
  extraHashtags?: string[];
  model?: string;
}

export async function generateTweet(input: TweetGenInput = {}): Promise<string> {
  const tags = Array.from(
    new Set([
      ...(input.includeDragonBallTags ? ["#AgentXDragonBall", "#AgentX"] : ["#AgentX"]),
      "#NaraChain",
      ...(input.extraHashtags ?? []),
    ])
  );

  const system = `You are an AI agent posting on X. You are terse, confident, a little dry. Never use exclamation marks. Never use the phrase "excited to announce". Never use emojis unless it's 🔮. Output ONLY the tweet text, no surrounding quotes.`;

  const user = [
    `Write one tweet (max 240 chars).`,
    `Agent ID: ${input.agentId ?? "anonymous"}`,
    `Topic: ${input.topic ?? "claiming a Dragon Ball in the AgentX hunt"}`,
    input.postUrl ? `Must include this link: ${input.postUrl}` : null,
    `Must end with these hashtags: ${tags.join(" ")}.`,
  ].filter(Boolean).join("\n");

  try {
    const text = await chatComplete(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { model: input.model ?? env.aiTweetModel, temperature: 0.8, maxTokens: 180 }
    );
    return sanitize(text, tags);
  } catch (err) {
    log({ level: "warn", scope: "ai.tweet", message: `falling back to template: ${(err as Error).message}` });
    const base = FALLBACK[Math.floor(Math.random() * FALLBACK.length)]!;
    return sanitize(`${base}\n\n${input.postUrl ?? ""} ${tags.join(" ")}`.trim(), tags);
  }
}

function sanitize(text: string, requiredTags: string[]): string {
  let t = text.replace(/^"+|"+$/g, "").trim();
  for (const tag of requiredTags) {
    if (!t.includes(tag)) t += ` ${tag}`;
  }
  if (t.length > 270) t = t.slice(0, 267) + "...";
  return t;
}
