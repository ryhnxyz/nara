import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { chatComplete, listModels } from "../ai/provider";
import { generateTweet } from "../ai/tweet-gen";
import { appendChatMessage, listThreads, openDb, threadMessages, getAgent } from "@nara-bot/db";
import { env } from "../lib/env";
import { runAgentTurn } from "../ai/agent-runtime";
import { runAgentTurnStream } from "../ai/agent-runtime-stream";

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
/**
 * Tool-calling agent (non-streaming) — JSON response.
 * Kept for compatibility; prefer /agent/stream for UX.
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

/**
 * Streaming tool-calling agent.
 * Returns SSE events: text-delta | tool-call-start | tool-call-result | step-end | done | error.
 * Client reconstructs the streamed text + renders tool calls live.
 */
aiRoute.post("/agent/stream", async (c) => {
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

  // Persist user message now so thread history is intact even if client disconnects
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

  return streamSSE(c, async (stream) => {
    let fullText = "";
    const toolSummary: Array<{ id: string; name: string; ok: boolean; durationMs: number }> = [];
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());

    try {
      for await (const ev of runAgentTurnStream({
        systemPrompt,
        history,
        userMessage: body.content,
        model: body.model,
        contextAgentDbId: contextAgent?.id ?? null,
        maxSteps: body.maxSteps ?? 6,
        signal: abort.signal,
      })) {
        // Forward every event to the client
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });

        if (ev.type === "text-delta") fullText += ev.delta;
        if (ev.type === "tool-call-result") {
          toolSummary.push({ id: ev.id, name: ev.name, ok: ev.ok, durationMs: ev.durationMs });
        }
        if (ev.type === "done" || ev.type === "error") {
          // Persist final assistant message so reload shows conversation
          const content = formatAgentResponse(
            fullText || (ev.type === "error" ? `(error: ${ev.message})` : "(no text)"),
            toolSummary
          );
          appendChatMessage(db, {
            threadId: body.threadId,
            agentId: contextAgent?.id ?? null,
            role: "assistant",
            content,
          });
          break;
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message }) });
      appendChatMessage(db, {
        threadId: body.threadId,
        agentId: contextAgent?.id ?? null,
        role: "assistant",
        content: `(stream error: ${message})`,
      });
    }
  });
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
    `You are an autonomous AI operator for the Nara Chain bot dashboard.`,
    `You have tool access to: agent registry (create/get/list/delete), wallet ops (balance/fund_from_master/transfer_from_agent), Twitter (bind_twitter/submit_daily_tweet), AgentX (stake_on_agentx/register_agent_onchain/check_dm_inbox/claim_dragonball), auto-distribute (run/configure/state), AI tweet generation, skills installation, logs, and the full run_flow orchestrator.`,
    agent ? `Current context agent: "${agent.agentId}" (id=${agent.id}, wallet=${agent.walletAddress ?? "pending"}, bound=${agent.twitterBound}, staked=${agent.staked}). When tools need an agent and the user didn't specify one, use this agent. NEVER call tools on other agents unless the user explicitly asks.` : `No agent context is set. If the user asks to run something agent-specific, either use list_agents and pick one that matches what they describe, or ask them to select in the UI.`,
    ``,
    `SCOPE & DATA ISOLATION:`,
    `- Only operate on agents and wallets within THIS dashboard instance. Never attempt to access other users' data.`,
    `- Never read, echo, or transmit wallet private keys, mnemonics, or API keys. If a tool returns secrets, summarize without printing them.`,
    `- Destructive ops (delete_agent, transfer_from_agent, run_distribute_now_for_agent with large amounts) REQUIRE explicit user confirmation in the chat before you call them.`,
    ``,
    `STANDARD FLOWS:`,
    `- New agent setup: create_agent → (wait for wallet auto-gen by route handler, check with get_agent) → get_master_wallet_state → fund_agent_from_master → run_flow (the flow handles register+bind+stake+tweet+dragon ball).`,
    `- Hunt Dragon Balls: check_dm_inbox → for each code returned, claim_dragonball (optionally with tweetUrl for 2x boost) → list_dragonball_claims to summarize.`,
    `- Daily maintenance: list_agents → for each active agent: get_balance, then either run_flow or submit_daily_tweet/check_dm_inbox individually.`,
    `- Consolidate earnings: get_distribute_state → run_distribute_now (batch) OR run_distribute_now_for_agent (single) → report totals.`,
    ``,
    `OPERATING PRINCIPLES:`,
    `- Think step by step. Call tools to gather facts before making claims.`,
    `- Chain tools freely. After a tool result, decide the next action based on real data, not assumptions.`,
    `- Be specific. Never invent tx hashes, balances, or Dragon Ball codes.`,
    `- Validate Dragon Ball codes match <8hex>.<22+alnum> before calling claim_dragonball.`,
    `- If a tool fails, read the error carefully — many failures are recoverable (e.g. cooldown, insufficient balance, already bound). Suggest the fix.`,
    `- Summarize results for the human in 1-3 short paragraphs after all tools finish. Use bullet points only when listing 3+ items.`,
    `- Speak Indonesian when the user speaks Indonesian, English otherwise.`,
  ].filter(Boolean).join("\n");
}

function formatAgentResponse(text: string, calls: Array<{ name: string; result?: unknown; error?: string }>): string {
  if (!calls.length) return text;
  const trace = calls
    .map((c) => `• ${c.name} → ${c.error ? `error: ${c.error}` : "ok"}`)
    .join("\n");
  return `${text}\n\n— tools used —\n${trace}`;
}
