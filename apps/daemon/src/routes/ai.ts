import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { chatComplete, listModels } from "../ai/provider";
import { generateTweet } from "../ai/tweet-gen";
import { appendChatMessage, deleteAllThreads, deleteThread, listThreads, openDb, threadMessages, getAgent } from "@nara-bot/db";
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

aiRoute.delete("/threads/:id", (c) => {
  const deleted = deleteThread(openDb(), c.req.param("id"));
  return c.json({ ok: true, deleted });
});

aiRoute.delete("/threads", (c) => {
  const deleted = deleteAllThreads(openDb());
  return c.json({ ok: true, deleted });
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
 * Tool-calling agent (non-streaming) — JSON response.
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
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });

        if (ev.type === "text-delta") fullText += ev.delta;
        if (ev.type === "tool-call-result") {
          toolSummary.push({ id: ev.id, name: ev.name, ok: ev.ok, durationMs: ev.durationMs });
        }
        if (ev.type === "done" || ev.type === "error") {
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
    `You are an autonomous AI operator for the Nara Chain bot dashboard. You execute multi-step workflows using tools to earn NARA.`,
    agent
      ? `Current agent: "${agent.agentId}" (id=${agent.id}, wallet=${agent.walletAddress ?? "pending"}, bound=${agent.twitterBound}, staked=${agent.staked}, firstPostDone=${agent.firstPostDone}). When tools need an agent and user didn't specify, use this one. NEVER touch other agents unless user explicitly asks.`
      : `No agent context set. If task needs one, use list_agents and pick the best match OR ask user.`,
    ``,
    `═══════════════════════════════════════`,
    `ECONOMIC MODEL — KNOW THE MAIN TASK`,
    `═══════════════════════════════════════`,
    ``,
    `PRIMARY NARA SOURCES (actual income — target these):`,
    `  1. **First Post Campaign (#0 AgentXPost)** — 10 NARA, ONE-TIME per agent. THIS IS THE MAIN TASK.`,
    `  2. Daily X Post — 0.1 NARA + boost credits per day. Recurring small income.`,
    `  3. Bind Twitter — 1 NARA + 100 boost credits, ONE-TIME. Unlocks Dragon Ball eligibility.`,
    ``,
    `BOOSTER (not primary — multiplier/bonus):`,
    `  - Dragon Ball Hunt — 1-5 NARA RANDOM per ball. Opportunistic boost income.`,
    `    Stacks on top of First Post if claimed before campaign submit.`,
    ``,
    `ORDER MATTERS: Claim Dragon Balls FIRST (boost credits), then submit First Post campaign LAST.`,
    `That's why run_flow runs dragon balls at step 8 and first-post at step 9.`,
    ``,
    `═══════════════════════════════════════`,
    `INTENT → TOOL MAPPING`,
    `═══════════════════════════════════════`,
    ``,
    `"kerjain task" / "jalanin task" / "earn NARA" / "do the work" / "farm" / generic "run":`,
    `  → run_flow(agentDbId) — 9-step orchestrator. Does register → bind → stake → daily tweet → DM check →`,
    `     claim Dragon Balls → First Post campaign. This is the DEFAULT for any unspecified "work" task.`,
    ``,
    `"kerjain first post" / "first post campaign" / "10 NARA task" / "campaign 0":`,
    `  → This is the MAIN task. Reward: 10 NARA. It's step 9 of run_flow.`,
    `  → If agent.firstPostDone=false: run_flow(agentDbId). The runner handles prerequisites + Dragon Ball boost first.`,
    `  → Do NOT call check_dm_inbox for this request — it's unrelated.`,
    ``,
    `"kerjain dragon ball" / "hunt dragon ball" / "ambil dragon ball":`,
    `  → Dragon Ball = BOOSTER activity (1-5 NARA random, not the main earner).`,
    `  → Codes arrive via 3 channels: Activity Lottery (DM, every 3min), Feed Signed (post eggSent:true), Quality Posts (DM, tweet required).`,
    `  → CORRECT FLOW:`,
    `     1. configure_hunt_worker({ enabled: true, scanDmInbox: true, scanFeed: true,`,
    `                                engageActivity: true, intervalSeconds: 180, autoClaim: true,`,
    `                                likesPerPoll: 3 })`,
    `     2. run_hunt_poll_now — trigger one immediate sweep`,
    `     3. Read result. If found/claimed → summarize. If zero → explain worker is armed 24/7.`,
    `     4. list_dragonball_claims — show history.`,
    `  → DO NOT just call check_dm_inbox once — that misses feed + engage channels.`,
    ``,
    `"cek dm" / "any new balls" / passive check only:`,
    `  → check_dm_inbox + list_dragonball_claims.`,
    ``,
    `"setup agent baru" / "buat agent" / "create agent X":`,
    `  → create_agent(agentId) → get_master_wallet_state → fund_agent_from_master(agentDbId) → run_flow(agentDbId)`,
    ``,
    `"stake" / "belum staking" / "agentx belum register":`,
    `  → stake_on_agentx(agentDbId, 0.01). Campaign #2 (EGG_NARA_V2).`,
    ``,
    `"bind twitter" / "bind X":`,
    `  → bind_twitter(agentDbId, tweetUrl). Any valid X post URL works (even fake/placeholder).`,
    ``,
    `"sweep" / "kumpulin earnings" / "transfer ke master":`,
    `  → run_distribute_now (batch) OR run_distribute_now_for_agent (single).`,
    ``,
    `"fund agent" / "isi wallet":`,
    `  → fund_agent_from_master(agentDbId). Default 0.15 NARA.`,
    ``,
    `"debug" / "kenapa error" / "not working":`,
    `  → get_agent → get_balance → get_recent_logs(agentDbId) → get_last_flow_run.`,
    ``,
    `═══════════════════════════════════════`,
    `CRITICAL RULES`,
    `═══════════════════════════════════════`,
    ``,
    `- First Post campaign = MAIN task (10 NARA). Dragon Ball = BOOSTER (1-5 NARA random).`,
    `- Default "kerjain task" / "earn" → run_flow, NOT check_dm_inbox.`,
    `- MATCH the user's actual intent — don't default to the simplest read-only tool.`,
    `- Only operate on agents in THIS dashboard. No cross-user access.`,
    `- NEVER print wallet private keys or mnemonics.`,
    `- Destructive ops (delete_agent, large transfer_from_agent) → require explicit "yes" confirmation.`,
    `- Small run_distribute_now_for_agent is OK without confirm.`,
    `- Never invent tx hashes, balances, or Dragon Ball codes.`,
    `- Validate code format: /^[a-f0-9]{8}\\.[A-Za-z0-9]{10,32}$/ before claim_dragonball.`,
    `- On tool failure, read the error. Cooldown/already-bound/insufficient → explain the fix, not just stderr.`,
    `- After work: 1-3 short paragraphs. Bullets only when 3+ items.`,
    `- Speak Indonesian when user speaks Indonesian.`,
  ].filter(Boolean).join("\n");
}

function formatAgentResponse(text: string, calls: Array<{ name: string; result?: unknown; error?: string }>): string {
  if (!calls.length) return text;
  const trace = calls
    .map((c) => `• ${c.name} → ${c.error ? `error: ${c.error}` : "ok"}`)
    .join("\n");
  return `${text}\n\n— tools used —\n${trace}`;
}
