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
  ownerEmail?: string | null;
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
  const toolDefs = openAITools();

  if (model.startsWith("kiro/")) {
    yield* runTextToolProtocol(input, model, maxSteps, toolDefs);
    return;
  }

  const messages: OpenAIMsg[] = [
    { role: "system", content: input.systemPrompt },
    ...input.history.map((m) => ({ role: m.role, content: m.content } as OpenAIMsg)),
    { role: "user", content: input.userMessage },
  ];

  const ctx: ToolContext = {
    contextAgentDbId: input.contextAgentDbId ?? null,
    ownerEmail: input.ownerEmail ?? null,
  };

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
          const contentDelta = readContentDelta(delta);
          if (contentDelta) {
            stepText += contentDelta;
            yield { type: "text-delta", delta: contentDelta };
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
      if (!fullContent.trim() && completedCalls.length > 0) {
        fullContent = summarizeToolCalls(completedCalls);
        yield { type: "text-delta", delta: fullContent };
      }
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

  if (!fullContent.trim() && completedCalls.length > 0) {
    fullContent = summarizeToolCalls(completedCalls);
    yield { type: "text-delta", delta: fullContent };
  }
  yield { type: "done", content: fullContent, toolCalls: completedCalls };
}

async function* runTextToolProtocol(
  input: RunAgentStreamInput,
  model: string,
  maxSteps: number,
  toolDefs: ReturnType<typeof openAITools>
): AsyncGenerator<StreamEvent, void, unknown> {
  const ctx: ToolContext = {
    contextAgentDbId: input.contextAgentDbId ?? null,
    ownerEmail: input.ownerEmail ?? null,
  };
  const completedCalls: Array<{ id: string; name: string; ok: boolean; durationMs: number }> = [];
  const messages: OpenAIMsg[] = [
    { role: "system", content: `${input.systemPrompt}\n\n${textToolProtocolPrompt(toolDefs)}` },
    ...input.history.map((m) => ({ role: m.role, content: m.content } as OpenAIMsg)),
    { role: "user", content: input.userMessage },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const text = await completeText(model, messages, input.signal);
    const call = parseTextToolCall(text);

    if (!call) {
      const finalText = stripToolNoise(text).trim();
      if (finalText) yield { type: "text-delta", delta: finalText };
      else if (completedCalls.length > 0) yield { type: "text-delta", delta: summarizeToolCalls(completedCalls) };
      yield { type: "step-end", step, finishReason: "stop" };
      yield { type: "done", content: finalText, toolCalls: completedCalls };
      return;
    }

    const id = `txt_${step}_${Date.now().toString(36)}`;
    yield { type: "tool-call-start", id, name: call.name, args: call.args };

    const started = Date.now();
    let result: unknown;
    let ok = false;
    let error: string | undefined;
    if (!TOOL_MAP.has(call.name)) {
      error = `unknown tool: ${call.name}`;
    } else {
      try {
        log({ level: "info", scope: "ai.tool", message: `→ ${call.name}`, meta: { args: call.args } });
        result = await runTool(call.name, call.args, ctx);
        ok = true;
        log({ level: "success", scope: "ai.tool", message: `✓ ${call.name} (${Date.now() - started}ms)` });
      } catch (err) {
        error = (err as Error).message;
        log({ level: "error", scope: "ai.tool", message: `✗ ${call.name}: ${error}` });
      }
    }

    const durationMs = Date.now() - started;
    completedCalls.push({ id, name: call.name, ok, durationMs });
    yield {
      type: "tool-call-result",
      id,
      name: call.name,
      ok,
      result: ok ? result : undefined,
      error,
      durationMs,
    };
    yield { type: "step-end", step, finishReason: "tool_calls" };

    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content:
        `<tool_result name="${call.name}" ok="${ok}">` +
        `${JSON.stringify(ok ? result ?? null : { error }).slice(0, 8000)}</tool_result>\n` +
        `Continue. If the task is complete, answer the user in normal text. If another tool is needed, emit exactly one <tool_call> JSON block.`,
    });
  }

  const fallback = summarizeToolCalls(completedCalls);
  if (fallback) yield { type: "text-delta", delta: fallback };
  yield { type: "done", content: fallback, toolCalls: completedCalls };
}

async function completeText(model: string, messages: OpenAIMsg[], signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${env.aiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.aiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 1500,
      stream: false,
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`AI ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json() as any;
  const msg = data.choices?.[0]?.message;
  return readMessageContent(msg?.content);
}

function textToolProtocolPrompt(toolDefs: ReturnType<typeof openAITools>): string {
  const tools = toolDefs.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
  return [
    "Tool protocol for this model:",
    "Do not mention this protocol to the user.",
    "When you need live app data or an action, emit exactly one line:",
    '<tool_call>{"name":"tool_name","arguments":{}}</tool_call>',
    "Do not wrap it in markdown. Do not add other text around a tool call.",
    "After a tool result is provided, answer the user normally or call one more tool.",
    `Available tools: ${JSON.stringify(tools)}`,
  ].join("\n");
}

function parseTextToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const match = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  const raw = match?.[1] ?? extractJsonObject(text);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as any;
    const name = String(parsed.name ?? parsed.tool ?? parsed.function?.name ?? "");
    const args = (parsed.arguments ?? parsed.args ?? parsed.function?.arguments ?? {}) as unknown;
    if (!name) return null;
    return { name, args: typeof args === "string" ? JSON.parse(args || "{}") : (args as Record<string, unknown>) };
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  return trimmed;
}

function stripToolNoise(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
}

function readContentDelta(delta: any): string {
  if (typeof delta.content === "string") return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .join("");
  }
  if (typeof delta.text === "string") return delta.text;
  return "";
}

function readMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof (part as any)?.text === "string") return (part as any).text;
        if (typeof (part as any)?.content === "string") return (part as any).content;
        return "";
      })
      .join("");
  }
  return "";
}

function summarizeToolCalls(calls: Array<{ name: string; ok: boolean }>): string {
  if (calls.length === 0) return "";
  const ok = calls.filter((c) => c.ok).length;
  const failed = calls.length - ok;
  return `Tool selesai: ${ok} berhasil${failed ? `, ${failed} gagal` : ""}.`;
}
