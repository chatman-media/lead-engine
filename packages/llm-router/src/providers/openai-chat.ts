import {
  ChatApiError,
  type ChatClient,
  type ChatCompletionOpts,
  type ChatMessage,
  type FetchLike,
  parseOpenAiSseStream,
} from "../types.ts";

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
    finish_reason?: string;
    message?: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  error?: { message?: string };
}

/**
 * Полнофункциональный OpenAI-совместимый chat-клиент. Поддерживает:
 *   - `.complete()` — стандартное single-turn / multi-turn generation
 *   - `.completeWithTools()` — function-calling (OpenAI tools API)
 *   - `.completeStructured()` — strict JSON schema через response_format
 *   - `.stream()` — token-by-token SSE streaming
 *
 * Работает с OpenAI API, а также с любым OpenAI-compatible endpoint
 * (Together, Anyscale, локальные vLLM-сервера через `--api OpenAI`).
 * Для OpenRouter и Ollama есть отдельные клиенты в этом же пакете —
 * у них protocol чуть отличается.
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

  async complete(messages: ChatMessage[], opts: ChatCompletionOpts = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
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
    const first = payload.choices?.[0]?.message?.content;
    if (!first) {
      throw new ChatApiError(res.status, "no choices returned by model");
    }
    return first;
  }

  async completeWithTools(
    messages: ChatMessage[],
    tools: Array<{
      type: "function";
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }>,
    opts: ChatCompletionOpts = {},
  ): Promise<{
    content: string | null;
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  }> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      tools,
      tool_choice: "auto",
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.numPredict !== undefined) body.max_tokens = opts.numPredict;

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    let payload: ChatResponse;
    try {
      payload = (await res.json()) as ChatResponse;
    } catch {
      throw new ChatApiError(res.status, "non-JSON response");
    }
    if (!res.ok) throw new ChatApiError(res.status, payload.error?.message ?? "unexpected error");

    const msg = payload.choices?.[0]?.message;
    if (!msg) throw new ChatApiError(res.status, "no choices returned by model");

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCalls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));
      return { content: null, toolCalls };
    }

    return { content: msg.content ?? "", toolCalls: [] };
  }

  async completeStructured(
    messages: ChatMessage[],
    jsonSchema: Record<string, unknown>,
    opts: ChatCompletionOpts = {},
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "output", schema: jsonSchema, strict: true },
      },
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.numPredict !== undefined) body.max_tokens = opts.numPredict;

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    let payload: ChatResponse;
    try {
      payload = (await res.json()) as ChatResponse;
    } catch {
      throw new ChatApiError(res.status, "non-JSON response");
    }
    if (!res.ok) throw new ChatApiError(res.status, payload.error?.message ?? "unexpected error");

    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new ChatApiError(res.status, "no content returned by model");
    return content;
  }

  async *stream(messages: ChatMessage[], opts: ChatCompletionOpts = {}): AsyncIterable<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
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

    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new ChatApiError(res.status, err.error?.message ?? "stream request failed");
    }

    yield* parseOpenAiSseStream(res.body);
  }
}
