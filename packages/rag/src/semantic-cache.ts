import type { AnswerResult, AnswerTelemetry } from "./answer-types.ts";
import type { EmbeddingClient } from "./embed.ts";

export interface SemanticCacheOptions {
  /**
   * Cosine similarity threshold for a cache hit (0–1). Higher = stricter.
   * Default: 0.92 — catches paraphrases and minor reformulations.
   */
  threshold?: number;
  /**
   * Maximum number of entries to keep in memory. Oldest entries are evicted
   * when the limit is reached. Default: 500.
   */
  maxEntries?: number;
  /**
   * TTL in milliseconds. Entries older than this are ignored. Default: 1 hour.
   * Set to `Infinity` to disable expiry.
   */
  ttlMs?: number;
}

interface CacheEntry {
  embedding: number[];
  result: AnswerResult;
  createdAt: number;
}

/**
 * In-memory semantic cache for `answerWithRag` results.
 *
 * Stores (question embedding → AnswerResult) pairs. On lookup, computes
 * cosine similarity between the incoming question embedding and all cached
 * embeddings, returning the best match above `threshold`.
 *
 * Use `SemanticCache.wrap()` to get a drop-in cached version of any async
 * function that accepts an `EmbeddingClient` and a question string.
 *
 * @example
 * ```ts
 * import { SemanticCache, answerWithRag } from "@chatman-media/rag";
 *
 * const cache = new SemanticCache(embedder, { threshold: 0.93, ttlMs: 30 * 60_000 });
 *
 * const result = await cache.getOrSet(
 *   input.question,
 *   () => answerWithRag(input),
 * );
 * ```
 */
export class SemanticCache {
  private readonly embedder: EmbeddingClient;
  private readonly threshold: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private entries: CacheEntry[] = [];

  /** Total cache hits since creation. */
  hits = 0;
  /** Total cache misses since creation. */
  misses = 0;

  constructor(embedder: EmbeddingClient, opts: SemanticCacheOptions = {}) {
    this.embedder = embedder;
    this.threshold = opts.threshold ?? 0.92;
    this.maxEntries = opts.maxEntries ?? 500;
    this.ttlMs = opts.ttlMs ?? 60 * 60_000;
  }

  /**
   * Look up `question` in the cache. If a similar question was cached and is
   * still fresh, returns the cached `AnswerResult` with `telemetry.path`
   * overridden to `"cache_hit"`. Otherwise calls `fn()`, stores the result,
   * and returns it.
   */
  async getOrSet(question: string, fn: () => Promise<AnswerResult>): Promise<AnswerResult> {
    const [queryVec] = await this.embedder.embed([question]);
    if (!queryVec) return fn();

    this.evictExpired();

    const hit = this.findBestMatch(queryVec);
    if (hit) {
      this.hits++;
      return {
        ...hit.result,
        telemetry: { ...hit.result.telemetry, path: "cache_hit" as AnswerTelemetry["path"] },
      };
    }

    this.misses++;
    const result = await fn();
    this.store(queryVec, result);
    return result;
  }

  /** Manually insert a question→result pair (e.g. from a warm-up script). */
  async prime(question: string, result: AnswerResult): Promise<void> {
    const [vec] = await this.embedder.embed([question]);
    if (vec) this.store(vec, result);
  }

  /** Remove all entries. */
  clear(): void {
    this.entries = [];
  }

  /** Number of live (non-expired) entries. */
  get size(): number {
    this.evictExpired();
    return this.entries.length;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private findBestMatch(queryVec: number[]): CacheEntry | null {
    let bestSim = -1;
    let bestEntry: CacheEntry | null = null;
    for (const entry of this.entries) {
      const sim = cosineSimilarity(queryVec, entry.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestEntry = entry;
      }
    }
    return bestSim >= this.threshold ? bestEntry : null;
  }

  private store(embedding: number[], result: AnswerResult): void {
    if (this.entries.length >= this.maxEntries) {
      // Evict oldest entry
      this.entries.shift();
    }
    this.entries.push({ embedding, result, createdAt: Date.now() });
  }

  private evictExpired(): void {
    if (this.ttlMs === Infinity) return;
    const cutoff = Date.now() - this.ttlMs;
    this.entries = this.entries.filter((e) => e.createdAt >= cutoff);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
