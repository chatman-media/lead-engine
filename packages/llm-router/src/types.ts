// Канал-агностичные интерфейсы LLM-провайдеров. Реализации (OpenAI / Ollama /
// OpenRouter / Anthropic / …) живут в `providers/`. Этот модуль не должен
// импортировать ничего из providers — providers зависят от него.

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
      /** Output-token cap. OpenAI `max_tokens`, Ollama `num_predict`. */
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

/**
 * Брошен `ChatClient.complete` когда модель оборвалась на лимите токенов
 * (OpenAI/OpenRouter `finish_reason === "length"`, Ollama
 * `done_reason === "length"`). Отдельный subclass чтобы вызывающий мог
 * различать: усечённый ответ = "выбрось и промолчи", обычный ChatApiError =
 * "запрос упал".
 *
 * `partial` несёт что модель успела сгенерировать до cap'а — для telemetry,
 * никогда не отправляется кандидату.
 */
export class ChatTruncatedError extends ChatApiError {
  constructor(
    public readonly partial: string,
    public readonly numPredict: number | undefined,
    public readonly finishReason: string,
  ) {
    super(
      599,
      `truncated by max_tokens (finish_reason=${finishReason}, numPredict=${numPredict ?? "default"}, partial="${partial.slice(0, 80)}")`,
    );
    this.name = "ChatTruncatedError";
  }
}

export interface EmbeddingClient {
  /** Эмбеддинги в том же порядке что и `inputs`. */
  embed(inputs: string[]): Promise<number[][]>;
  readonly dim: number;
}

export class EmbeddingApiError extends Error {
  constructor(
    public statusCode: number,
    public description: string,
  ) {
    super(`Embedding request failed (${statusCode}): ${description}`);
    this.name = "EmbeddingApiError";
  }
}

/**
 * No-op эмбеддер — возвращает нулевые векторы заданной размерности. Используется
 * чтобы выключить vector retrieval (RAG остаётся на BM25/keyword) и в тестах
 * где нет доступа к настоящему эмбеддингу.
 */
export class NullEmbeddingClient implements EmbeddingClient {
  readonly dim: number;
  constructor(dim: number) {
    this.dim = dim;
  }
  async embed(inputs: string[]): Promise<number[][]> {
    return inputs.map(() => new Array<number>(this.dim).fill(0));
  }
}
