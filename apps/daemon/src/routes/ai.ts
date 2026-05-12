import { Hono } from "hono";
import { chatComplete, listModels } from "../ai/provider";
import { generateTweet } from "../ai/tweet-gen";
import { appendChatMessage, listThreads, openDb, threadMessages, getAgent } from "@nara-bot/db";
import { env } from "../lib/env";
import { runAgentTurn } from "../ai/agent-runtime";

export const aiRoute = new Hono();

aiRoute.get("/models", async (c) => {
  const models = await listModels();
  return c.json({
    models: models.length ? models : [env.aiModel, env.aiTweetModel].filter(Boolean),
    baseUrl: env.aiBaseUrl,
    default: env.aiModel,
    configured: !!env.aiApiKey,
  });
});

aiRoute.post("/tweet", async (c) => {
  const body = await c.req.json<{
    agentId?: string;
    topic?: string;
    postUrl?: string;
    includeDragonBallTags?: boolean;
    model?: string;
  }>().catch(() => ({}));
  try {
    const tweet = await generateTweet(body);
    return c.json({ tweet });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

aiRoute.get("/threads", (c) => {
  const threads = listThreads(openDb());
  return c.json({ threads });
});

aiRoute.get("/threads/:id", (c) => {
  const messages = threadMessages(openDb(), c.req.param("id"));
  return c.json({ messages });
});

/**
 * Simple chat (no tools) — used for plain Q&A.
 */
aiRoute.post("/chat", async (c) => {
  const body = await c.req.json<{
    threadId: string;
    agentDbId?: string;
    content: string;
    model?: string;
    systemExtra?: string;
  }>();

  if (!body.threadId || !body.content) {
    return c.json({ error: "threadId and content required" }, 400);
  }

  const db = openDb();
  const agent = body.agentDbId ? getAgent(db, body.agentDbId) : null;

  appendChatMessage(db, {
    threadId: body.threadId,
    agentId: agent?.id ?? null,
    role: "user",
    content: body.content,
  });

  const history = threadMessages(db, body.threadId, 40);

  const system = buildSystemPrompt(agent, body.systemExtra);

  const messages = [
    { role: "system" as const, content: system },
    ...history.map((m) => ({
      role: m.role === "tool" ? ("assistant" as const) : (m.role as "user" | "assistant"),
      content: m.content,
    })),
  ];

  try {
    const answer = await chatComplete(messages, {
      model: body.model ?? env.aiModel,
      temperature: 0.6,
      maxTokens: 1024,
    });
    const saved = appendChatMessage(db, {
      threadId: body.threadId,
      agentId: agent?.id ?? null,
      role: "assistant",
      content: answer,
    });
    return c.json({ message: saved });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * Tool-calling agent — full opencode-style autonomy.
 * The AI can call tools (list_agents, run_flow, claim_dragonball, etc.)
 * and chain them until the task is done.
 */
aiRoute.post("/agent", async (c) => {
  const body = await c.req.json<{
    threadId: string;
    agentDbId?: string;
    content: string;
    model?: string;
    maxSteps?: number;
  }>();

  if (!body.threadId || !body.content) {
    return c.json({ error: "threadId and content required" }, 400);
  }

  const db = openDb();
  const contextAgent = body.agentDbId ? getAgent(db, body.agentDbId) : null;

  appendChatMessage(db, {
    threadId: body.threadId,
    agentId: contextAgent?.id ?? null,
    role: "user",
    content: body.content,
  });

  const history = threadMessages(db, body.threadId, 40)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(0, -1)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const systemPrompt = buildAgenticSystemPrompt(contextAgent);

  try {
    const turn = await runAgentTurn({
      systemPrompt,
      history,
      userMessage: body.content,
      model: body.model,
      contextAgentDbId: contextAgent?.id ?? null,
      maxSteps: body.maxSteps ?? 6,
    });

    const finalText = turn.content || "(no text response — see tool calls)";
    const saved = appendChatMessage(db, {
      threadId: body.threadId,
      agentId: contextAgent?.id ?? null,
      role: "assistant",
      content: formatAgentResponse(finalText, turn.toolCalls),
    });

    return c.json({
      message: saved,
      toolCalls: turn.toolCalls,
      finishReason: turn.finishReason,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

function buildSystemPrompt(agent: any, extra?: string): string {
  return [
    `You are ${agent?.displayName ?? "a Nara Chain AI agent"} operating on the NARA blockchain.`,
    agent ? `Your on-chain agent-id is "${agent.agentId}". Wallet: ${agent.walletAddress ?? "not generated yet"}.` : null,
    `You understand Nara: NARA coin, PoMI mining, AgentX feed, Dragon Ball Hunt, Memesis.`,
    `Be concise. Plain text. Never invent transaction hashes or balances.`,
    extra ?? "",
  ].filter(Boolean).join("\n");
}

function buildAgenticSystemPrompt(agent: any): string {
  return [
    `You are an autonomous AI operator for a Nara Chain bot dashboard.`,
    `You have direct tool access to: wallet creation, on-chain registration, Twitter binding, staking, Dragon Ball claiming, auto-distribute sweeping, and live logs.`,
    agent ? `Current context agent: "${agent.agentId}" (id=${agent.id}, wallet=${agent.walletAddress ?? "pending"}, bound=${agent.twitterBound}, staked=${agent.staked}). When tools need an agent and the user didn't specify, use this one.` : `No agent context set. If the user asks to run something agent-specific, either use list_agents to pick one or ask.`,
    ``,
    `OPERATING PRINCIPLES:`,
    `- Think step by step. Call tools to gather facts before claiming anything.`,
    `- Chain tools freely. After a tool result, decide the next action.`,
    `- Be specific. Never invent tx hashes, balances, or Dragon Ball codes.`,
    `- When the user asks an open-ended goal (e.g. "farm NARA for agent X"), plan: list_agents -> get_balance -> run_flow -> report.`,
    `- For manual claims, validate code format <8hex>.<22+alnum> before calling claim_dragonball.`,
    `- Summarize results for the human in 1-3 short paragraphs after all tools finish.`,
    `- Never echo secrets or wallet private keys.`,
  ].filter(Boolean).join("\n");
}

function formatAgentResponse(text: string, calls: Array<{ name: string; result?: unknown; error?: string }>): string {
  if (!calls.length) return text;
  const trace = calls
    .map((c) => `• ${c.name} → ${c.error ? `error: ${c.error}` : "ok"}`)
    .join("\n");
  return `${text}\n\n— tools used —\n${trace}`;
}
