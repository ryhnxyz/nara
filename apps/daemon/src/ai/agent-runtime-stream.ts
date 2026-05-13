/**
 * Streaming tool-calling AI agent runtime.
 *
 * Yields SSE-style events so the client sees output token-by-token:
 *   - text-delta       : chunk of assistant text (streamed from model)
 *   - tool-call-start  : AI decided to call a tool (with args)
 *   - tool-call-result : tool finished (ok or error)
 *   - step-end         : one model-step finished (may loop to next)
 *   - done             : whole turn finished
 *   - error            : fatal error (aborts loop)
 */

import { env } from "../lib/env";
import { log } from "../lib/logger";
import { openAITools, runTool, TOOL_MAP, type ToolContext } from "./tools";

export type StreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call-start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool-call-result"; id: string; name: string; ok: boolean; result?: unknown; error?: string; durationMs: number }
  | { type: "step-end"; step: number; finishReason: string | null }
  | { type: "done"; content: string; toolCalls: Array<{ id: string; name: string; ok: boolean; durationMs: number }> }
  | { type: "error"; message: string };

export interface RunAgentStreamInput {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  model?: string;
  contextAgentDbId?: string | null;
  maxSteps?: number;
  signal?: AbortSignal;
}

interface OpenAIMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  argsText: string;
}

export async function* runAgentTurnStream(
  input: RunAgentStreamInput
): AsyncGenerator<StreamEvent, void, unknown> {
  if (!env.aiApiKey) {
    yield { type: "error", message: "AI_API_KEY not configured" };
    return;
  }
  const model = input.model ?? env.aiModel;
  const maxSteps = input.maxSteps ?? 6;

  const messages: OpenAIMsg[] = [
    { role: "system", content: input.systemPrompt },
    ...input.history.map((m) => ({ role: m.role, content: m.content } as OpenAIMsg)),
    { role: "user", content: input.userMessage },
  ];

  const toolDefs = openAITools();
  const ctx: ToolContext = { contextAgentDbId: input.contextAgentDbId ?? null };

  let fullContent = "";
  const completedCalls: Array<{ id: string; name: string; ok: boolean; durationMs: number }> = [];

  for (let step = 0; step < maxSteps; step++) {
    let res: Response;
    try {
      res = await fetch(`${env.aiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.aiApiKey}`,
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          messages,
          tools: toolDefs,
          tool_choice: "auto",
          temperature: 0.3,
          max_tokens: 1500,
          stream: true,
        }),
        signal: input.signal,
      });
    } catch (err) {
      yield { type: "error", message: `upstream fetch failed: ${(err as Error).message}` };
      return;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      yield { type: "error", message: `AI ${res.status}: ${text.slice(0, 400)}` };
      return;
    }

    // Accumulators for this step
    let stepText = "";
    const accCalls = new Map<number, AccumulatedToolCall>();
    let finishReason: string | null = null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      if (input.signal?.aborted) {
        yield { type: "error", message: "cancelled" };
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events split by "\n\n". Each block has one or more "data: ..." lines.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const rawLine of block.split("\n")) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content.length > 0) {
            stepText += delta.content;
            yield { type: "text-delta", delta: delta.content };
          }
          // Claude Opus 4.7 reasoning stream (via opencode router)
          const reasoningDelta =
            (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
            (typeof delta.reasoning === "string" && delta.reasoning) ||
            (delta.reasoning && typeof delta.reasoning.content === "string" && delta.reasoning.content) ||
            (Array.isArray(delta.reasoning_details) && delta.reasoning_details[0]?.text) ||
            "";
          if (reasoningDelta) {
            yield { type: "reasoning-delta", delta: reasoningDelta };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const slot = tc.index ?? 0;
              let acc = accCalls.get(slot);
              if (!acc) {
                acc = { id: tc.id ?? `tc_${step}_${slot}`, name: tc.function?.name ?? "", argsText: "" };
                accCalls.set(slot, acc);
              }
              if (tc.id && !acc.id.startsWith("tc_")) acc.id = tc.id;
              if (tc.id && acc.id.startsWith("tc_")) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (typeof tc.function?.arguments === "string") {
                acc.argsText += tc.function.arguments;
              }
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
    }

    // Append assistant turn to message history (for next step's context)
    const toolCallsForHistory = Array.from(accCalls.values()).map((a) => ({
      id: a.id,
      type: "function" as const,
      function: { name: a.name, arguments: a.argsText },
    }));
    messages.push({
      role: "assistant",
      content: stepText || null,
      ...(toolCallsForHistory.length ? { tool_calls: toolCallsForHistory } : {}),
    });

    fullContent += stepText;

    yield { type: "step-end", step, finishReason };

    // If no tool calls → model is done responding
    if (accCalls.size === 0) {
      yield { type: "done", content: fullContent, toolCalls: completedCalls };
      return;
    }

    // Execute tool calls (parallel)
    const execPromises = Array.from(accCalls.values()).map(async (acc) => {
      const started = Date.now();
      let args: Record<string, unknown> = {};
      try {
        args = acc.argsText ? JSON.parse(acc.argsText) : {};
      } catch (err) {
        return {
          id: acc.id,
          name: acc.name,
          ok: false,
          error: `invalid JSON arguments: ${(err as Error).message}`,
          durationMs: Date.now() - started,
          args: {},
        };
      }

      if (!TOOL_MAP.has(acc.name)) {
        return {
          id: acc.id,
          name: acc.name,
          ok: false,
          error: `unknown tool: ${acc.name}`,
          durationMs: Date.now() - started,
          args,
        };
      }

      log({ level: "info", scope: "ai.tool", message: `→ ${acc.name}`, meta: { args } });
      try {
        const result = await runTool(acc.name, args, ctx);
        log({
          level: "success",
          scope: "ai.tool",
          message: `✓ ${acc.name} (${Date.now() - started}ms)`,
        });
        return { id: acc.id, name: acc.name, ok: true, result, durationMs: Date.now() - started, args };
      } catch (err) {
        const message = (err as Error).message;
        log({ level: "error", scope: "ai.tool", message: `✗ ${acc.name}: ${message}` });
        return { id: acc.id, name: acc.name, ok: false, error: message, durationMs: Date.now() - started, args };
      }
    });

    // Emit start events (so UI shows them immediately), then await results.
    for (const acc of accCalls.values()) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = acc.argsText ? JSON.parse(acc.argsText) : {};
      } catch {}
      yield { type: "tool-call-start", id: acc.id, name: acc.name, args: parsedArgs };
    }

    const results = await Promise.all(execPromises);

    for (const r of results) {
      completedCalls.push({ id: r.id, name: r.name, ok: r.ok, durationMs: r.durationMs });
      yield {
        type: "tool-call-result",
        id: r.id,
        name: r.name,
        ok: r.ok,
        result: r.ok ? (r as any).result : undefined,
        error: r.ok ? undefined : r.error,
        durationMs: r.durationMs,
      };
      // Push into conversation for next model step
      messages.push({
        role: "tool",
        tool_call_id: r.id,
        content: JSON.stringify(r.ok ? (r as any).result ?? null : { error: r.error }).slice(0, 8000),
      });
    }
  }

  yield { type: "done", content: fullContent, toolCalls: completedCalls };
}
