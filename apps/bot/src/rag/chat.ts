export type FetchLike = typeof fetch;

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatClient {
  complete(
    messages: ChatMessage[],
    opts?: {
      temperature?: number;
      /** Optional output-token cap (`num_predict` for Ollama, `max_tokens`
       *  for OpenAI). Implementations free to ignore or pick a default. */
      numPredict?: number;
    },
  ): Promise<string>;
}

export class ChatApiError extends Error {
  constructor(
    public statusCode: number,
    public description: string,
  ) {
    super(`Chat completion failed (${statusCode}): ${description}`);
    this.name = "ChatApiError";
  }
}

export interface OpenAIChatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Per-request timeout in ms. Default 60_000 (1 min). */
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface ChatResponse {
  choices?: Array<{
    index?: number;
    message?: { role: string; content: string };
  }>;
  error?: { message?: string };
}

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

  async complete(messages: ChatMessage[], opts: { temperature?: number } = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

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
    const first = payload.choices?.[0]?.message?.content;
    if (!first) {
      throw new ChatApiError(res.status, "no choices returned by model");
    }
    return first;
  }
}
