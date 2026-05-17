import type { KbSearchHit } from "./types.ts";

/**
 * Cross-encoder reranker interface. Called after initial retrieval (vector /
 * hybrid) to re-score and re-order hits using a more expensive but accurate
 * relevance model. Optional third stage in the retrieval pipeline.
 */
export interface Reranker {
  rerank(query: string, hits: KbSearchHit[], topK?: number): Promise<KbSearchHit[]>;
}

// ── Cohere ────────────────────────────────────────────────────────────────────

export interface CohereRerankerOptions {
  apiKey: string;
  /** Default: "rerank-v3.5" */
  model?: string;
  /** Base URL. Default: "https://api.cohere.com/v2" */
  baseUrl?: string;
  /** Per-request timeout ms. Default: 30_000. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface CohereRerankResponse {
  results?: Array<{ index: number; relevance_score: number }>;
  message?: string;
}

/**
 * Reranker backed by the Cohere Rerank API.
 *
 * @example
 * ```ts
 * import { CohereReranker } from "@chatman-media/rag";
 *
 * const reranker = new CohereReranker({ apiKey: process.env.COHERE_API_KEY! });
 * const reranked = await reranker.rerank(question, hits, 5);
 * ```
 */
export class CohereReranker implements Reranker {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CohereRerankerOptions) {
    if (!opts.apiKey) throw new Error("CohereReranker: apiKey required");
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "rerank-v3.5";
    this.baseUrl = (opts.baseUrl ?? "https://api.cohere.com/v2").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async rerank(query: string, hits: KbSearchHit[], topK?: number): Promise<KbSearchHit[]> {
    if (hits.length === 0) return hits;
    const k = topK ?? hits.length;

    const res = await this.fetchImpl(`${this.baseUrl}/rerank`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: hits.map((h) => h.text),
        top_n: k,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const payload = (await res.json()) as CohereRerankResponse;
    if (!res.ok || !payload.results) {
      throw new Error(`CohereReranker: ${payload.message ?? `HTTP ${res.status}`}`);
    }

    return payload.results.slice(0, k).flatMap(({ index, relevance_score }) => {
      const hit = hits[index];
      if (!hit) return [];
      // Remap to distance convention: lower = more relevant
      return [{ ...hit, distance: 1 - relevance_score }];
    });
  }
}

// ── Jina ──────────────────────────────────────────────────────────────────────

export interface JinaRerankerOptions {
  apiKey: string;
  /** Default: "jina-reranker-v2-base-multilingual" */
  model?: string;
  /** Base URL. Default: "https://api.jina.ai/v1" */
  baseUrl?: string;
  /** Per-request timeout ms. Default: 30_000. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface JinaRerankResponse {
  results?: Array<{ index: number; relevance_score: number }>;
  detail?: string;
}

/**
 * Reranker backed by the Jina Reranker API.
 * The default model is multilingual — works well for Russian and Chinese KB.
 *
 * @example
 * ```ts
 * import { JinaReranker } from "@chatman-media/rag";
 *
 * const reranker = new JinaReranker({ apiKey: process.env.JINA_API_KEY! });
 * const reranked = await reranker.rerank(question, hits, 5);
 * ```
 */
export class JinaReranker implements Reranker {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JinaRerankerOptions) {
    if (!opts.apiKey) throw new Error("JinaReranker: apiKey required");
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "jina-reranker-v2-base-multilingual";
    this.baseUrl = (opts.baseUrl ?? "https://api.jina.ai/v1").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async rerank(query: string, hits: KbSearchHit[], topK?: number): Promise<KbSearchHit[]> {
    if (hits.length === 0) return hits;
    const k = topK ?? hits.length;

    const res = await this.fetchImpl(`${this.baseUrl}/rerank`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: hits.map((h) => h.text),
        top_n: k,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const payload = (await res.json()) as JinaRerankResponse;
    if (!res.ok || !payload.results) {
      throw new Error(`JinaReranker: ${payload.detail ?? `HTTP ${res.status}`}`);
    }

    return payload.results.slice(0, k).flatMap(({ index, relevance_score }) => {
      const hit = hits[index];
      if (!hit) return [];
      return [{ ...hit, distance: 1 - relevance_score }];
    });
  }
}
