// Канал-агностичные интерфейсы LLM-провайдеров. Реализации (OpenAI / Ollama /
// OpenRouter / Anthropic / …) живут в `providers/`. Этот модуль не должен
// импортировать ничего из providers — providers зависят от него.
//
// История: до PR refactor/llm-router-absorb chat/embed/providers жили в
// `packages/rag` (теперь `packages/kb`), дублируясь с упрощёнными копиями
// здесь. Теперь llm-router — единственный source of truth.

export type FetchLike = typeof fetch;

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  /**
   * Null допустим ТОЛЬКО для assistant-сообщений, несущих `tool_calls`
   * вместо текста (OpenAI tool-calling API). Все остальные роли требуют
   * non-null строку.
   */
  content: string | null;
  /** Populated by the model when it decides to call a tool. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** Required when role === "tool" — references the tool_call id. */
  tool_call_id?: string;
}

/**
 * Provider-reported token counts для одного completion'а. Все поля optional —
 * провайдер заполняет лишь то, что вернул его API (`usage`-блок). Нормализованная
 * форма: разные провайдеры зовут поля по-разному (OpenAI `prompt_tokens`, Ollama
 * `prompt_eval_count`), здесь — единое имя.
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatCompletionOpts {
  temperature?: number;
  /** Optional output-token cap (`num_predict` for Ollama, `max_tokens`
   *  for OpenAI). Implementations free to ignore or pick a default. */
  numPredict?: number;
  /**
   * Опциональный колбэк — вызывается один раз за completion с токенами из
   * `usage`-блока ответа (если провайдер его вернул). Метрик-wrapper в apps/api
   * подсовывает сюда запись в `llm_usage_events`. Провайдер, который не знает
   * счётчика, просто никогда его не зовёт — обратная совместимость сохранена.
   */
  onUsage?: (usage: TokenUsage) => void;
}

/**
 * Сырая форма `usage`-блока OpenAI-совместимых API (OpenAI, OpenRouter и любой
 * `/chat/completions` прокси). Ollama использует другие имена — у него парсинг
 * inline.
 */
export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Нормализует OpenAI-style `usage` и зовёт `opts.onUsage`, если он задан и в
 * ответе вообще были числа. No-op без колбэка или без usage — провайдеры могут
 * звать безусловно после парсинга ответа.
 */
export function reportOpenAiUsage(
  opts: ChatCompletionOpts | undefined,
  usage: OpenAiUsage | undefined,
): void {
  if (!opts?.onUsage || !usage) return;
  const normalized: TokenUsage = {};
  if (typeof usage.prompt_tokens === "number") normalized.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number")
    normalized.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") normalized.totalTokens = usage.total_tokens;
  if (Object.keys(normalized).length > 0) opts.onUsage(normalized);
}

export interface ChatClient {
  complete(messages: ChatMessage[], opts?: ChatCompletionOpts): Promise<string>;
  /**
   * Token-by-token streaming variant. Yields raw text chunks as they arrive.
   * Optional — callers should check `typeof client.stream === "function"`
   * before using, or fall back to `complete()`.
   */
  stream?(messages: ChatMessage[], opts?: ChatCompletionOpts): AsyncIterable<string>;
  /**
   * Tool-calling variant. Возвращает либо text response, либо list of tool
   * calls которые модель хочет сделать. Optional — fallback на prompt-based
   * tool injection если не реализовано.
   */
  completeWithTools?(
    messages: ChatMessage[],
    tools: Array<{
      type: "function";
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }>,
    opts?: ChatCompletionOpts,
  ): Promise<{
    content: string | null;
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  }>;
  /**
   * Structured output variant. Returns a raw JSON string validated against the
   * provided JSON Schema. Uses OpenAI's `response_format` when available.
   * Optional — `answerWithRag` falls back to prompt injection when not implemented.
   */
  completeStructured?(
    messages: ChatMessage[],
    jsonSchema: Record<string, unknown>,
    opts?: ChatCompletionOpts,
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

/** Parse OpenAI-compatible SSE stream, yielding text delta chunks. */
export async function* parseOpenAiSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
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
          // malformed SSE line — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
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
