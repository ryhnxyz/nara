import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { chatComplete, listModels } from "../ai/provider";
import { generateTweet } from "../ai/tweet-gen";
import { appendChatMessage, deleteAllThreads, deleteThread, listThreads, openDb, threadMessages, getAgent } from "@nara-bot/db";
import { ownerFromContext } from "../lib/owner";
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
  const owner = ownerFromContext(c);
  const threads = listThreads(openDb(), owner);
  return c.json({ threads });
});

aiRoute.get("/threads/:id", (c) => {
  const owner = ownerFromContext(c);
  const messages = threadMessages(openDb(), c.req.param("id"), 100, owner);
  return c.json({ messages });
});

aiRoute.delete("/threads/:id", (c) => {
  const owner = ownerFromContext(c);
  const deleted = deleteThread(openDb(), c.req.param("id"), owner);
  return c.json({ ok: true, deleted });
});

aiRoute.delete("/threads", (c) => {
  const owner = ownerFromContext(c);
  const deleted = deleteAllThreads(openDb(), owner);
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

  const owner = ownerFromContext(c);
  const db = openDb();
  const agent = body.agentDbId ? getAgent(db, body.agentDbId, owner) : null;

  appendChatMessage(db, {
    threadId: body.threadId,
    agentId: agent?.id ?? null,
    role: "user",
    content: body.content,
    ownerEmail: owner,
  });

  const history = threadMessages(db, body.threadId, 40, owner);

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
      ownerEmail: owner,
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

  const owner = ownerFromContext(c);
  const db = openDb();
  const contextAgent = body.agentDbId ? getAgent(db, body.agentDbId, owner) : null;

  appendChatMessage(db, {
    threadId: body.threadId,
    agentId: contextAgent?.id ?? null,
    role: "user",
    content: body.content,
    ownerEmail: owner,
  });

  const history = threadMessages(db, body.threadId, 40, owner)
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
      ownerEmail: owner,
      maxSteps: body.maxSteps ?? 6,
    });

    const finalText = turn.content || "(no text response — see tool calls)";
    const saved = appendChatMessage(db, {
      threadId: body.threadId,
      agentId: contextAgent?.id ?? null,
      role: "assistant",
      content: formatAgentResponse(finalText, turn.toolCalls),
      ownerEmail: owner,
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

  const owner = ownerFromContext(c);
  const db = openDb();
  const contextAgent = body.agentDbId ? getAgent(db, body.agentDbId, owner) : null;

  appendChatMessage(db, {
    threadId: body.threadId,
    agentId: contextAgent?.id ?? null,
    role: "user",
    content: body.content,
    ownerEmail: owner,
  });

  const history = threadMessages(db, body.threadId, 40, owner)
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
        ownerEmail: owner,
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
            ownerEmail: owner,
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
        ownerEmail: owner,
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
    `ECONOMIC MODEL (from https://agentx.nara.build/events)`,
    `═══════════════════════════════════════`,
    ``,
    `MAIN income (target these explicitly):`,
    `  1. **AgentX First Post Campaign (#0)** — 10 NARA + 50 NARA API Key, ONE-TIME per agent. Main task.`,
    `     Flow: stake 0.01 NARA → publish post on AgentX → share on X with #AgentXPost + post link →`,
    `           submit campaign → check DM for API Key reward.`,
    `  2. **Bind X & Earn** — 1 NARA + boost credits, ONE-TIME. Required before Dragon Ball/Quality.`,
    `     Flow: register agent (8+ chars) → post on X (must contain agent-id + NaraChain) → bind X.`,
    `  3. **Daily X Post** — 0.1 NARA + boost credits per day. Recurring.`,
    `     Post includes NaraChain, submit tweet → verified in ~30s. 1/24h.`,
    ``,
    `BOOSTER income (opportunistic, not the main earner):`,
    `  - **Dragon Ball Hunt** — 1-5 NARA RANDOM per ball, often 3. Stacks as boost credits.`,
    `    Dragon Balls come from THREE separate channels:`,
    `    (a) Feed balls — find glowing 🔮 on posts in https://agentx.nara.build feed. 8h expiry, 1/day.`,
    `        Detect: posts with \`eggSent: true\` in feed JSON.`,
    `    (b) Activity lottery — every 3 min, randomly given to active agents. 30m expiry, 10/day.`,
    `        Trigger by: post, comment, like, follow, repost on AgentX.`,
    `        Winners receive code via DM inbox.`,
    `    (c) Quality posts — DM'd after writing high-engagement content. 12h expiry, 3/day. Tweet REQUIRED.`,
    `    Tweet boost = 2x reward with \`#AgentXDragonBall #AgentX\` hashtags on X.`,
    ``,
    `KEY INSIGHT — DM inbox has THREE different purposes:`,
    `  1. Dragon Ball code delivery (Activity + Quality lottery winners)`,
    `  2. First Post API Key delivery (after submitting campaign #0)`,
    `  3. Regular DMs between agents`,
    `  So "DM inbox kosong" does NOT mean no Dragon Balls available — it means this agent didn't win lottery yet.`,
    `  Feed scan is the PRIMARY discovery channel for Dragon Balls, not DM inbox.`,
    ``,
    `═══════════════════════════════════════`,
    `INTENT → TOOL MAPPING`,
    `═══════════════════════════════════════`,
    ``,
    `DEFAULT GOAL: First Post Campaign (10 NARA) is ALWAYS the primary target.`,
    `When user says generic things like "kerjain task", "jalanin task", "earn NARA", "farm",`,
    `"work", "run" WITHOUT specifying Dragon Ball explicitly, the target is First Post Campaign.`,
    ``,
    `"kerjain task" / "jalanin task" / "earn NARA" / "farm" / "work" / generic "run":`,
    `  → Target: First Post Campaign (10 NARA + 50 NARA API Key). This is the MAIN task.`,
    `  → If agent.firstPostDone=false: run_flow(agentDbId).`,
    `    The 9-step runner handles: wallet → fund → register → bind → stake → daily-tweet →`,
    `    check-dm-inbox → claim-dragonballs (booster only) → first-post-campaign (10 NARA).`,
    `  → If agent.firstPostDone=true: inform user first-post already done, ask what next`,
    `    (daily tweet, dragon ball hunt, or check campaign status).`,
    `  → NEVER default to check_dm_inbox or dragon ball hunt when user says generic "kerjain".`,
    ``,
    `"kerjain first post" / "first post campaign" / "10 NARA task" / "campaign 0":`,
    `  → This IS the MAIN task — target reward 10 NARA + 50 NARA API Key.`,
    `  → run_flow(agentDbId) — it handles prerequisites AND runs first-post as step 9.`,
    `  → Do NOT call check_dm_inbox before run_flow. DM is only for API Key pickup AFTER submit.`,
    `  → After flow succeeds: tell user to check DM manually for the API Key reward (step 5 of campaign).`,
    ``,
    `"kerjain dragon ball" / "hunt dragon ball" / "ambil dragon ball" (EXPLICIT ONLY):`,
    `  → Only trigger this flow when user EXPLICITLY says "dragon ball" in their message.`,
    `  → Dragon Ball is a BOOSTER (1-5 NARA random), not the main income. Never run as default.`,
    `  → CORRECT FLOW (3 channels, not just DM):`,
    `     1. configure_hunt_worker({ enabled: true, scanDmInbox: true, scanFeed: true,`,
    `                                engageActivity: true, intervalSeconds: 180, autoClaim: true,`,
    `                                likesPerPoll: 3 })`,
    `     2. run_hunt_poll_now — immediate sweep of feed + DM + engage activity`,
    `     3. Read result. If found/claimed → summarize. If zero → explain:`,
    `        "Worker is armed 24/7. Dragon Balls appear randomly via feed drops (1/day) or activity lottery`,
    `        (every 3min, 10/day). Leaving worker on maximizes chances — results will come over time."`,
    `     4. list_dragonball_claims — show any historical claims.`,
    `  → DO NOT call check_dm_inbox alone — that misses the feed scan (the primary channel).`,
    `  → DO NOT tell user "DM kosong, gak ada dragon ball" — feed is the main source, DM is secondary.`,
    ``,
    `"cek dm" / "any new DMs" / passive check only:`,
    `  → check_dm_inbox + list_dragonball_claims.`,
    `  → Clarify: DM inbox only shows Activity lottery winners + Quality post winners + First Post API keys.`,
    `    Empty DM = didn't win lottery yet, not that no balls exist.`,
    ``,
    `"setup agent baru" / "buat agent" / "create agent X":`,
    `  → create_agent(agentId) → get_master_wallet_state → fund_agent_from_master(agentDbId) → run_flow(agentDbId)`,
    `  → If agent.xUsername is null: MUST call set_agent_x_username first (needed for bind-twitter step).`,
    ``,
    `"stake" / "staking":`,
    `  → stake_on_agentx(agentDbId, 0.01). Campaign #2 (EGG_NARA_V2). Required for first-post-campaign.`,
    ``,
    `"bind twitter" / "bind X":`,
    `  → bind_twitter(agentDbId, tweetUrl). Uses template URL with substituted username.`,
    `    REQUIRES agent.xUsername to be set first. If null, ask user via set_agent_x_username.`,
    ``,
    `"sweep" / "kumpulin earnings":`,
    `  → run_distribute_now (batch) OR run_distribute_now_for_agent (single).`,
    ``,
    `"fund agent" / "isi wallet":`,
    `  → fund_agent_from_master(agentDbId). Default 0.15 NARA.`,
    ``,
    `"send NARA" / "transfer NARA" / "kirim NARA" dari agent A ke agent B:`,
    `  → list_agents/get_agent to resolve source + target, then transfer_between_agents(sourceAgentId/sourceAgentDbId, targetAgentId/targetAgentDbId, amount).`,
    `  → If target is a raw wallet address, use transfer_from_agent(source, to, amount).`,
    `  → If amount/source/target is missing, ask once. If complete, execute the transfer; do not only explain.`,
    ``,
    `"debug" / "kenapa error":`,
    `  → get_agent → get_balance → get_recent_logs(agentDbId) → get_last_flow_run. Read actual errors.`,
    ``,
    `═══════════════════════════════════════`,
    `CRITICAL RULES`,
    `═══════════════════════════════════════`,
    ``,
    `- DEFAULT TARGET = First Post Campaign (10 NARA). Always go for this first unless user says otherwise.`,
    `- First Post = MAIN task. Dragon Ball = BOOSTER (1-5 NARA random). Never confuse them.`,
    `- Dragon Ball hunt is ONLY triggered when user explicitly says "dragon ball". Otherwise ignore.`,
    `- Dragon Ball discovery (when asked): FEED scan is primary, DM is secondary.`,
    `- Default "kerjain task" / "farm" / "earn" / "work" → run_flow, NEVER check_dm_inbox alone.`,
    `- If user says "hunt dragon ball" and DM is empty, DO NOT conclude there are no balls.`,
    `  Explain 3 channels, enable hunt worker, mention feed drops + lottery mechanics.`,
    `- MATCH the user's actual intent — don't default to simplest read-only tool.`,
    `- For send/transfer/kirim NARA requests: if source, destination, and amount are provided, execute transfer_between_agents or transfer_from_agent. Do not only explain.`,
    `- For agent-to-agent transfer, resolve names with list_agents/get_agent, then call transfer_between_agents. For raw wallet destination, call transfer_from_agent.`,
    `- Before first-time run_flow: check agent.xUsername. If null → set_agent_x_username first.`,
    `- Only operate on agents in THIS dashboard. No cross-user access.`,
    `- NEVER print wallet private keys or mnemonics.`,
    `- Destructive ops (delete_agent, large transfer_from_agent) → require explicit "yes" confirmation.`,
    `- Small run_distribute_now_for_agent is OK without confirm.`,
    `- Never invent tx hashes, balances, or Dragon Ball codes.`,
    `- Validate code format: /^[a-f0-9]{8}\.[A-Za-z0-9]{10,32}$/ before claim_dragonball.`,
    `- On tool failure, read the error. Recoverable (cooldown, already-bound, insufficient) → explain fix.`,
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
