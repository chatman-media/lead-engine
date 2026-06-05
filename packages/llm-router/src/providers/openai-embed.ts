import { type EmbeddingClient, EmbeddingApiError, type FetchLike } from "../types.ts";

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  dim: number;
  /** Per-request timeout, ms. Default 60_000. */
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface EmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
  error?: { message?: string };
}

/**
 * OpenAI-совместимый embedding client. Same baseUrl-trick как у chat client —
 * подходит для любого OpenAI-API endpoint'а.
 *
 * Автоматически батчит inputs (96 за раз) чтобы влезать в OpenAI-лимиты
 * (2048 inputs / ~300k tokens на request).
 */
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
      throw new EmbeddingApiError(res.status, body.error?.message ?? "unexpected response shape");
    }
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    if (sorted.length !== inputs.length) {
      throw new EmbeddingApiError(
        res.status,
        `expected ${inputs.length} embeddings, got ${sorted.length}`,
      );
    }
    return sorted.map((d) => this.fitDim(d.embedding, res.status));
  }

  /**
   * Приводит вектор модели к целевой размерности `this.dim` — чтобы БЗ
   * (колонка vector(N)) работала с любой современной моделью, у которой
   * размерность отличается.
   *
   *  - len === dim → как есть.
   *  - len  >  dim → обрезаем до dim + L2-перенормировка. Для Matryoshka-моделей
   *    (OpenAI text-embedding-3-*, Gemini embedding и т.п.) это официально
   *    поддерживаемый способ снизить размерность без потери качества.
   *  - len  <  dim → нельзя «дофантазировать» недостающие компоненты → понятная
   *    ошибка (нужна модель с размерностью ≥ dim).
   */
  private fitDim(embedding: number[], status: number): number[] {
    if (embedding.length === this.dim) return embedding;
    if (embedding.length < this.dim) {
      throw new EmbeddingApiError(
        status,
        `model "${this.model}" returned ${embedding.length}-dim vectors, but ${this.dim} required — ` +
          `choose an embedding model with dimensions ≥ ${this.dim}`,
      );
    }
    const sliced = embedding.slice(0, this.dim);
    let norm = 0;
    for (const v of sliced) norm += v * v;
    norm = Math.sqrt(norm);
    return norm > 0 ? sliced.map((v) => v / norm) : sliced;
  }
}
