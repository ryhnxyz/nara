import { env } from "../lib/env";
import { log } from "../lib/logger";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: false;
}

/**
 * OpenAI-compatible chat completion using the opencode proxy credentials.
 * Base URL and API key come from the root .env (AI_BASE_URL, AI_API_KEY).
 */
export async function chatComplete(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  if (!env.aiApiKey) {
    throw new Error("AI_API_KEY not configured in .env — set it to the opencode router key");
  }

  const model = opts.model ?? env.aiModel;
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 1024,
    stream: false,
  };

  const res = await fetch(`${env.aiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.aiApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    log({ level: "error", scope: "ai", message: `AI ${res.status}: ${errText.slice(0, 200)}` });
    throw new Error(`AI provider ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const text = json.choices?.[0]?.message?.content ?? "";
  return text;
}

export async function listModels(): Promise<string[]> {
  if (!env.aiApiKey) return [];
  try {
    const res = await fetch(`${env.aiBaseUrl.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${env.aiApiKey}` },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}
