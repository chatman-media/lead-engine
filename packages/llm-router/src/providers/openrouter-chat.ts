import {
  ChatApiError,
  type ChatClient,
  type ChatCompletionOpts,
  type ChatMessage,
  type FetchLike,
  type OpenAiUsage,
  reportOpenAiUsage,
} from "../types.ts";

/**
 * OpenRouter chat client. OpenRouter exposes an OpenAI-compatible
 * `/chat/completions` API but multiplexes hundreds of underlying models
 * (Anthropic Claude, OpenAI GPT, Google Gemini, Meta Llama, Qwen, etc.)
 * behind a single API key. Useful for:
 *
 * - Running the bot on Claude/GPT without slow local Ollama.
 * - A/B-testing the same persona across model backbones.
 * - Burst capacity when on-prem Ollama can't keep up with traffic.
 *
 * Two optional headers help OpenRouter attribute traffic to your app:
 *   - `HTTP-Referer` — your app's URL
 *   - `X-Title`      — your app's name
 * Both show up in OR's dashboard. Skip them if you don't want analytics.
 *
 * Docs: https://openrouter.ai/docs
 */

export interface OpenRouterChatOptions {
  apiKey: string;
  /** Default: https://openrouter.ai/api/v1 */
  baseUrl?: string;
  /** Model id as OpenRouter expects, e.g. "anthropic/claude-haiku-4.5". */
  model: string;
  /** Optional analytics: your app's URL. Sent as `HTTP-Referer`. */
  siteUrl?: string;
  /** Optional analytics: your app's name. Sent as `X-Title`. */
  appName?: string;
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
  usage?: OpenAiUsage;
  error?: { message?: string; code?: number | string };
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenRouterChatClient implements ChatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly siteUrl: string | undefined;
  private readonly appName: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpenRouterChatOptions) {
    if (!opts.apiKey || opts.apiKey.trim().length === 0) {
      throw new Error("OpenRouterChatClient: apiKey required");
    }
    if (!opts.model || opts.model.trim().length === 0) {
      throw new Error("OpenRouterChatClient: model required");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/{1,512}$/, "");
    this.model = opts.model;
    this.siteUrl = opts.siteUrl;
    this.appName = opts.appName;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async complete(messages: ChatMessage[], opts: ChatCompletionOpts = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
    // OpenRouter's HTTP-Referer + X-Title attribution headers are optional —
    // skipping them just leaves the request unattributed in the dashboard.
    if (this.siteUrl) headers["HTTP-Referer"] = this.siteUrl;
    if (this.appName) headers["X-Title"] = this.appName;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new ChatApiError(0, `OpenRouter unreachable at ${this.baseUrl}: ${cause}`);
    }

    let payload: ChatResponse;
    try {
      payload = (await res.json()) as ChatResponse;
    } catch {
      throw new ChatApiError(res.status, "non-JSON response from OpenRouter");
    }

    if (!res.ok) {
      throw new ChatApiError(
        res.status,
        payload.error?.message ?? `OpenRouter error (HTTP ${res.status})`,
      );
    }
    if (payload.error) {
      throw new ChatApiError(
        res.status,
        payload.error.message ?? "OpenRouter returned error without a message",
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content || content.trim().length === 0) {
      throw new ChatApiError(res.status, "no choices[0].message.content in OpenRouter response");
    }
    reportOpenAiUsage(opts, payload.usage);
    return content.trim();
  }

  /** Заголовки запроса (auth + опциональная атрибуция OpenRouter). */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
    if (this.siteUrl) headers["HTTP-Referer"] = this.siteUrl;
    if (this.appName) headers["X-Title"] = this.appName;
    return headers;
  }

  /**
   * Function-calling. OpenRouter проксирует OpenAI-совместимый tools API —
   * формат идентичен openai-chat. Нужен для агентных инструментов (обменник:
   * computeQuote/createOrder/fetchRequisites и т.п.), иначе модель не может
   * вызывать tools и бот не отвечает по сценарию обмена.
   */
  async completeWithTools(
    messages: ChatMessage[],
    tools: Array<{
      type: "function";
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      };
    }>,
    opts: ChatCompletionOpts = {},
  ): Promise<{
    content: string | null;
    toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }>;
  }> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      tools,
      tool_choice: "auto",
      stream: false,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.numPredict !== undefined) body.max_tokens = opts.numPredict;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new ChatApiError(0, `OpenRouter unreachable at ${this.baseUrl}: ${cause}`);
    }

    let payload: ChatResponse;
    try {
      payload = (await res.json()) as ChatResponse;
    } catch {
      throw new ChatApiError(res.status, "non-JSON response from OpenRouter");
    }
    if (!res.ok || payload.error) {
      throw new ChatApiError(
        res.status,
        payload.error?.message ?? `OpenRouter error (HTTP ${res.status})`,
      );
    }

    const msg = payload.choices?.[0]?.message;
    if (!msg) throw new ChatApiError(res.status, "no choices returned by OpenRouter");
    reportOpenAiUsage(opts, payload.usage);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCalls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));
      return { content: msg.content ?? null, toolCalls };
    }
    return { content: msg.content ?? "", toolCalls: [] };
  }

  /** Strict JSON через response_format (OpenAI-совместимо). */
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
      stream: false,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.numPredict !== undefined) body.max_tokens = opts.numPredict;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new ChatApiError(0, `OpenRouter unreachable at ${this.baseUrl}: ${cause}`);
    }

    let payload: ChatResponse;
    try {
      payload = (await res.json()) as ChatResponse;
    } catch {
      throw new ChatApiError(res.status, "non-JSON response from OpenRouter");
    }
    if (!res.ok || payload.error) {
      throw new ChatApiError(
        res.status,
        payload.error?.message ?? `OpenRouter error (HTTP ${res.status})`,
      );
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new ChatApiError(res.status, "no content returned by OpenRouter");
    reportOpenAiUsage(opts, payload.usage);
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

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
    if (this.siteUrl) headers["HTTP-Referer"] = this.siteUrl;
    if (this.appName) headers["X-Title"] = this.appName;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new ChatApiError(0, `OpenRouter unreachable at ${this.baseUrl}: ${cause}`);
    }

    if (!res.ok || !res.body) {
      const errPayload = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new ChatApiError(
        res.status,
        errPayload.error?.message ?? `OpenRouter stream error (HTTP ${res.status})`,
      );
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const token = chunk.choices?.[0]?.delta?.content;
            if (token) yield token;
          } catch {
            // skip malformed SSE line
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
