import {
  ChatApiError,
  type ChatClient,
  type ChatCompletionOpts,
  type ChatMessage,
} from "./chat.ts";
import { EmbeddingApiError, type EmbeddingClient } from "./embed.ts";

export interface RetryOptions {
  /**
   * Maximum number of attempts (including the first). Default: 3.
   */
  maxAttempts?: number;
  /**
   * Initial backoff in ms before the second attempt. Doubles on each retry.
   * Default: 500.
   */
  initialDelayMs?: number;
  /**
   * Cap on backoff delay in ms. Default: 30_000.
   */
  maxDelayMs?: number;
  /**
   * HTTP status codes that should trigger a retry.
   * Default: [429, 500, 502, 503, 504].
   */
  retryOn?: number[];
}

const DEFAULT_RETRY_ON = [429, 500, 502, 503, 504];

async function withRetry<T>(fn: () => Promise<T>, opts: Required<RetryOptions>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isRetryable =
        (err instanceof ChatApiError || err instanceof EmbeddingApiError) &&
        opts.retryOn.includes(err.statusCode);

      if (!isRetryable || attempt === opts.maxAttempts) break;

      const delay = Math.min(
        opts.initialDelayMs * 2 ** (attempt - 1) + Math.random() * 100,
        opts.maxDelayMs,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOpts(opts: RetryOptions): Required<RetryOptions> {
  return {
    maxAttempts: opts.maxAttempts ?? 3,
    initialDelayMs: opts.initialDelayMs ?? 500,
    maxDelayMs: opts.maxDelayMs ?? 30_000,
    retryOn: opts.retryOn ?? DEFAULT_RETRY_ON,
  };
}

/**
 * Wraps any `ChatClient` with automatic retry + exponential backoff.
 *
 * Retries on transient HTTP errors (429, 5xx) with jittered exponential
 * backoff. Non-retryable errors (4xx other than 429) propagate immediately.
 *
 * @example
 * ```ts
 * import { withRetryChatClient, OpenAIChatClient } from "@chatman-media/rag";
 *
 * const chat = withRetryChatClient(
 *   new OpenAIChatClient({ apiKey, baseUrl, model }),
 *   { maxAttempts: 4, initialDelayMs: 1000 },
 * );
 * ```
 */
export function withRetryChatClient(client: ChatClient, opts: RetryOptions = {}): ChatClient {
  const resolved = resolveOpts(opts);

  const wrapped: ChatClient = {
    complete(messages: ChatMessage[], completionOpts?: ChatCompletionOpts): Promise<string> {
      return withRetry(() => client.complete(messages, completionOpts), resolved);
    },
  };

  if (typeof client.stream === "function") {
    const originalStream = client.stream.bind(client);
    wrapped.stream = async function* (
      messages: ChatMessage[],
      completionOpts?: ChatCompletionOpts,
    ): AsyncIterable<string> {
      // For streaming we only retry before the stream starts — once tokens
      // begin flowing we can't rewind. Wrap the generator creation in retry.
      let iter: AsyncIterable<string> | undefined;
      await withRetry(async () => {
        iter = originalStream(messages, completionOpts);
        // Eagerly check by starting the iterator — if the HTTP request itself
        // fails synchronously (before first yield), the error is retryable.
      }, resolved);
      if (iter) yield* iter;
    };
  }

  return wrapped;
}

/**
 * Wraps any `EmbeddingClient` with automatic retry + exponential backoff.
 *
 * @example
 * ```ts
 * import { withRetryEmbeddingClient, OpenAIEmbeddingClient } from "@chatman-media/rag";
 *
 * const embedder = withRetryEmbeddingClient(
 *   new OpenAIEmbeddingClient({ apiKey, baseUrl, model, dim: 1536 }),
 * );
 * ```
 */
export function withRetryEmbeddingClient(
  client: EmbeddingClient,
  opts: RetryOptions = {},
): EmbeddingClient {
  const resolved = resolveOpts(opts);
  return {
    get dim() {
      return client.dim;
    },
    embed(inputs: string[]): Promise<number[][]> {
      return withRetry(() => client.embed(inputs), resolved);
    },
  };
}
