import { ChatApiError, type ChatClient, type ChatMessage } from "../chat.ts";

export type FetchLike = typeof fetch;

export interface OllamaChatOptions {
  host: string;
  model: string;
  fetch?: FetchLike;
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

  constructor(opts: OllamaChatOptions) {
    this.host = opts.host.replace(/\/+$/, "");
    this.model = opts.model;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async complete(
    messages: ChatMessage[],
    opts: { temperature?: number } = {},
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };
    if (opts.temperature !== undefined) {
      body.options = { temperature: opts.temperature };
    }

    const res = await this.fetchImpl(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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
