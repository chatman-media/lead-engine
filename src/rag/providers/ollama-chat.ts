import { ChatApiError, type ChatClient, type ChatMessage } from "../chat.ts";

export type FetchLike = typeof fetch;

export interface OllamaChatOptions {
  host: string;
  model: string;
  fetch?: FetchLike;
  /**
   * Disable "thinking" / chain-of-thought blocks for models that emit them
   * by default (e.g. qwen3, deepseek-r1). Defaults to `true` — we want fast,
   * production-style replies, not 3-minute reasoning preambles.
   * Set to `false` only if you actively need the reasoning trace.
   */
  disableThinking?: boolean;
  /**
   * Per-request timeout in milliseconds. Defaults to 5 min — enough room for
   * a cold qwen3 model load (~3 min for the 8B Q4_K_M weights) plus a short
   * generation. Once warm, requests come back in seconds. Bun's default fetch
   * timeout is too short for the first call after a model unload, which
   * silently kills the assistant reply (DOMException TimeoutError) — that's
   * what bit us during local testing.
   */
  timeoutMs?: number;
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  done?: boolean;
  error?: string;
}

export class OllamaChatClient implements ChatClient {
  private readonly host: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly disableThinking: boolean;
  private readonly timeoutMs: number;

  constructor(opts: OllamaChatOptions) {
    this.host = opts.host.replace(/\/+$/, "");
    this.model = opts.model;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.disableThinking = opts.disableThinking ?? true;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  }

  async complete(
    messages: ChatMessage[],
    opts: { temperature?: number; numPredict?: number } = {},
  ): Promise<string> {
    // num_ctx kept modest to keep KV-cache small (qwen3 default = 40K → 11GB
    // VRAM, way more than we need; 5 chunks × 1500 chars ≈ 1700 tokens).
    // num_predict caps reply length so the bot never rambles. Tests can
    // override to bound output time on slow CPU.
    const ollamaOptions: Record<string, unknown> = {
      num_ctx: 4096,
      num_predict: opts.numPredict ?? 256,
    };
    if (opts.temperature !== undefined) {
      ollamaOptions.temperature = opts.temperature;
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.disableThinking ? injectNoThinkHint(messages) : messages,
      stream: false,
      // Keep the model resident — avoids 5–10 sec re-loads between Telegram
      // messages while still freeing memory after long idle.
      keep_alive: "30m",
      options: ollamaOptions,
    };
    if (this.disableThinking) {
      body.think = false;
    }

    const res = await this.fetchImpl(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ChatApiError(res.status, text || "ollama chat error");
    }

    let payload: OllamaChatResponse;
    try {
      payload = (await res.json()) as OllamaChatResponse;
    } catch {
      throw new ChatApiError(res.status, "non-JSON response");
    }
    const content = payload.message?.content;
    if (!content) {
      throw new ChatApiError(res.status, "no message.content in ollama response");
    }
    return content;
  }
}

/**
 * For thinking-capable Qwen models (qwen3, qwen2.5-thinking), the magic
 * token `/no_think` in the user/system message disables the `<think>…</think>`
 * preamble. Older Ollama versions ignore the top-level `think: false` flag,
 * so we belt-and-suspenders by injecting the hint into the system message
 * (or prepending one if absent). Idempotent and harmless on other models.
 */
function injectNoThinkHint(messages: ChatMessage[]): ChatMessage[] {
  const HINT = "/no_think";
  const hasHint = messages.some((m) => typeof m.content === "string" && m.content.includes(HINT));
  if (hasHint) return messages;

  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx === -1) {
    return [{ role: "system", content: HINT }, ...messages];
  }
  const sys = messages[sysIdx]!;
  const updated: ChatMessage = {
    ...sys,
    content: `${HINT}\n\n${sys.content}`,
  };
  const next = messages.slice();
  next[sysIdx] = updated;
  return next;
}
