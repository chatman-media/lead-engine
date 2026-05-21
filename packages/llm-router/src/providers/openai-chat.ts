import {
  ChatApiError,
  type ChatClient,
  type ChatMessage,
  ChatTruncatedError,
  type FetchLike,
} from "../types.ts";

export interface OpenAIChatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Per-request timeout, ms. Default 60_000. */
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface ChatResponse {
  choices?: Array<{
    index?: number;
    message?: { role: string; content: string };
    finish_reason?: string;
  }>;
  error?: { message?: string };
}

/**
 * OpenAI-совместимый chat client. Кроме самого OpenAI (api.openai.com/v1)
 * этот же класс подходит для любого OpenAI-API endpoint'а: Azure OpenAI,
 * Together, Anyscale, локальные сервера с OpenAI-compat шиммом и т.д.
 */
export class OpenAIChatClient implements ChatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpenAIChatOptions) {
    if (!opts.apiKey) throw new Error("OpenAIChatClient: apiKey required");
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async complete(
    messages: ChatMessage[],
    opts: { temperature?: number; numPredict?: number } = {},
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    // numPredict — кросс-провайдерное имя; для OpenAI = max_tokens.
    if (opts.numPredict !== undefined) body.max_tokens = opts.numPredict;

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    let payload: ChatResponse;
    try {
      payload = (await res.json()) as ChatResponse;
    } catch {
      throw new ChatApiError(res.status, "non-JSON response");
    }
    if (!res.ok) {
      throw new ChatApiError(res.status, payload.error?.message ?? "unexpected error");
    }
    const choice = payload.choices?.[0];
    const first = choice?.message?.content;
    if (!first) {
      throw new ChatApiError(res.status, "no choices returned by model");
    }
    // Усечение по max_tokens — отдельный исключительный путь, см. ChatTruncatedError.
    if (choice?.finish_reason === "length") {
      throw new ChatTruncatedError(first, opts.numPredict, choice.finish_reason);
    }
    return first;
  }
}
