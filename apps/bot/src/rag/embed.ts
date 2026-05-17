export type FetchLike = typeof fetch;

export interface EmbeddingClient {
  /** Returns embeddings in the same order as `inputs`. */
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

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  dim: number;
  /** Per-request timeout in ms. Default 60_000 (1 min). */
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface EmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
  error?: { message?: string };
}

export class OpenAIEmbeddingClient implements EmbeddingClient {
  readonly dim: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpenAIEmbeddingOptions) {
    if (!opts.apiKey) throw new Error("OpenAIEmbeddingClient: apiKey required");
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.dim = opts.dim;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    // OpenAI limits: 2048 inputs per request and ~300k tokens per request.
    // Split into batches of 96 strings to stay well under both limits.
    const BATCH_SIZE = 96;
    if (inputs.length > BATCH_SIZE) {
      const results: number[][] = [];
      for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
        const batch = inputs.slice(i, i + BATCH_SIZE);
        const batchResult = await this.embed(batch);
        results.push(...batchResult);
      }
      return results;
    }
    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: inputs }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let body: EmbeddingResponse;
    try {
      body = (await res.json()) as EmbeddingResponse;
    } catch {
      throw new EmbeddingApiError(res.status, "non-JSON response");
    }
    if (!res.ok || !body.data) {
      throw new EmbeddingApiError(res.status, body.error?.message ?? `unexpected response shape`);
    }
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    if (sorted.length !== inputs.length) {
      throw new EmbeddingApiError(
        res.status,
        `expected ${inputs.length} embeddings, got ${sorted.length}`,
      );
    }
    for (const item of sorted) {
      if (item.embedding.length !== this.dim) {
        throw new Error(
          `Embedding dim mismatch: expected ${this.dim}, got ${item.embedding.length}`,
        );
      }
    }
    return sorted.map((d) => d.embedding);
  }
}

export class NullEmbeddingClient implements EmbeddingClient {
  readonly dim: number;
  constructor(dim: number) {
    this.dim = dim;
  }
  async embed(inputs: string[]): Promise<number[][]> {
    return inputs.map(() => new Array<number>(this.dim).fill(0));
  }
}
