import { ChatApiError, type ChatClient, type ChatMessage, type FetchLike } from "../chat.ts";

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
    message?: { role: string; content: string };
  }>;
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
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model;
    this.siteUrl = opts.siteUrl;
    this.appName = opts.appName;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async complete(messages: ChatMessage[], opts: { temperature?: number } = {}): Promise<string> {
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
    return content.trim();
  }
}
