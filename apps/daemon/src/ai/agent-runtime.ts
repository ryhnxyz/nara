/**
 * Tool-calling AI agent runtime — same pattern as opencode.
 *
 * The AI is given access to bot-control tools and can decide when to call them.
 * We run a loop: chat -> tool_calls? -> execute -> feed back -> repeat.
 */

import { env } from "../lib/env";
import { log } from "../lib/logger";
import { openAITools, runTool, TOOL_MAP, type ToolContext } from "./tools";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface AgentTurn {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

interface OpenAIMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface RunAgentInput {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  model?: string;
  contextAgentDbId?: string | null;
  ownerEmail?: string | null;
  maxSteps?: number;
}

export async function runAgentTurn(input: RunAgentInput): Promise<AgentTurn> {
  if (!env.aiApiKey) throw new Error("AI_API_KEY not configured");
  const model = input.model ?? env.aiModel;
  const maxSteps = input.maxSteps ?? 6;

  const messages: OpenAIMsg[] = [
    { role: "system", content: input.systemPrompt },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.userMessage },
  ];

  const toolDefs = openAITools();
  const ctx: ToolContext = {
    contextAgentDbId: input.contextAgentDbId ?? null,
    ownerEmail: input.ownerEmail ?? null,
  };
  const toolCalls: ToolCall[] = [];
  let finalContent = "";
  let finishReason: string | null = null;

  for (let step = 0; step < maxSteps; step++) {
    const res = await fetch(`${env.aiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.aiApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: toolDefs,
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: 1500,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`AI ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      choices: Array<{
        message: {
          role: "assistant";
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string | null;
      }>;
    };

    const choice = json.choices?.[0];
    if (!choice) throw new Error("no choices returned");

    const msg = choice.message;
    finishReason = choice.finish_reason ?? null;

    // Append assistant turn (with tool_calls if any)
    messages.push({
      role: "assistant",
      content: msg.content,
      tool_calls: msg.tool_calls,
    });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalContent = msg.content ?? "";
      break;
    }

    // Execute tool calls in parallel
    const results = await Promise.all(
      msg.tool_calls.map(async (tc) => {
        const started = Date.now();
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch (err) {
          return {
            id: tc.id,
            name: tc.function.name,
            arguments: {},
            error: `invalid JSON arguments: ${(err as Error).message}`,
            durationMs: Date.now() - started,
          } as ToolCall;
        }

        if (!TOOL_MAP.has(tc.function.name)) {
          return {
            id: tc.id,
            name: tc.function.name,
            arguments: args,
            error: `unknown tool: ${tc.function.name}`,
            durationMs: Date.now() - started,
          } as ToolCall;
        }

        log({
          level: "info",
          scope: "ai.tool",
          message: `→ ${tc.function.name}`,
          meta: { args },
        });

        try {
          const result = await runTool(tc.function.name, args, ctx);
          log({
            level: "success",
            scope: "ai.tool",
            message: `✓ ${tc.function.name} (${Date.now() - started}ms)`,
          });
          return {
            id: tc.id,
            name: tc.function.name,
            arguments: args,
            result,
            durationMs: Date.now() - started,
          } as ToolCall;
        } catch (err) {
          const message = (err as Error).message;
          log({
            level: "error",
            scope: "ai.tool",
            message: `✗ ${tc.function.name}: ${message}`,
          });
          return {
            id: tc.id,
            name: tc.function.name,
            arguments: args,
            error: message,
            durationMs: Date.now() - started,
          } as ToolCall;
        }
      })
    );

    toolCalls.push(...results);

    // Feed tool results back
    for (const r of results) {
      messages.push({
        role: "tool",
        tool_call_id: r.id,
        content: JSON.stringify(r.error ? { error: r.error } : (r.result ?? null)).slice(0, 8000),
      });
    }

    // Loop: the model will now incorporate tool output and may call more tools or respond.
  }

  return { content: finalContent, toolCalls, finishReason };
}
