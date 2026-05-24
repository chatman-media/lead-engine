/**
 * Post-retrieval utilities for the RAG pipeline.
 *
 * Two independent transforms, applied in order after the initial vector/hybrid
 * search returns its hits:
 *
 * 1. **`applyDynamicThreshold`** — trim hits that are "too far" from the query.
 *    Prevents hallucination-inducing weak matches from polluting the context.
 *
 * 2. **`mmrDiversify`** — re-rank via Maximal Marginal Relevance so that the
 *    final context window covers diverse sub-topics rather than repeating the
 *    same dense cluster of near-duplicate chunks.
 *
 * Both functions are pure (no I/O) and operate on the {@link KbSearchHit} array
 * that comes back from `IKbStore.search` / `IKbStore.hybridSearch`.
 */

import type { KbSearchHit } from "./types.ts";

// ── Dynamic threshold ────────────────────────────────────────────────────────

export interface DynamicThresholdOpts {
  /**
   * Drop hits whose `distance` exceeds this value.
   * Cosine distance is in [0, 2]; typical "useful" range is ≤ 0.4.
   * Default: 0.45.
   */
  threshold?: number;
  /**
   * Always keep at least this many hits even if they all exceed the threshold.
   * Prevents the context from going completely empty.
   * Default: 1.
   */
  minHits?: number;
}

/**
 * Trim hits that exceed a distance threshold, keeping at least `minHits`.
 *
 * When the best match is already weak (high distance), the whole batch is
 * likely unhelpful — cap it so the model isn't given noise.
 */
export function applyDynamicThreshold(
  hits: KbSearchHit[],
  opts: DynamicThresholdOpts = {},
): KbSearchHit[] {
  const { threshold = 0.45, minHits = 1 } = opts;
  if (hits.length === 0) return hits;

  const filtered = hits.filter((h) => h.distance <= threshold);
  return filtered.length >= minHits ? filtered : hits.slice(0, minHits);
}

// ── MMR diversification ──────────────────────────────────────────────────────

export interface MmrOpts {
  /**
   * Trade-off between relevance and diversity.
   * - 1.0 → pure relevance (same as original ranking)
   * - 0.0 → pure diversity (greedy maximum coverage)
   * Default: 0.6.
   */
  lambda?: number;
  /**
   * Maximum number of hits to return after diversification.
   * Defaults to the full input length.
   */
  topK?: number;
}

/**
 * Maximal Marginal Relevance re-ranking.
 *
 * Iteratively selects the next chunk that maximises:
 *   `score = λ * relevance - (1 - λ) * max_similarity_to_already_selected`
 *
 * Relevance is derived from the search distance (lower distance = higher
 * relevance). Inter-chunk similarity is approximated with **Jaccard overlap on
 * trigrams** — cheap, no extra embedder call required, and surprisingly
 * effective at detecting paraphrase duplicates.
 *
 * @param hits  Sorted by relevance (best first), as returned by the store.
 */
export function mmrDiversify(hits: KbSearchHit[], opts: MmrOpts = {}): KbSearchHit[] {
  const { lambda = 0.6, topK } = opts;
  const k = Math.min(topK ?? hits.length, hits.length);
  if (k <= 1 || hits.length <= 1) return hits.slice(0, k);

  // Pre-compute trigram sets for each hit (character trigrams on lowercased text).
  const trigramSets = hits.map((h) => trigrams(h.text));

  // Normalise distances to relevance scores in [0, 1].
  // Lower distance = higher relevance.  Shift by max so the worst hit = 0.
  const maxDist = Math.max(...hits.map((h) => h.distance));
  const relevance = hits.map((h) => (maxDist > 0 ? 1 - h.distance / maxDist : 1));

  const selected: number[] = []; // indices into `hits`
  const remaining = new Set(hits.map((_, i) => i));

  while (selected.length < k && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const idx of remaining) {
      const rel = relevance[idx]!;
      let maxSim = 0;
      for (const selIdx of selected) {
        const sim = jaccardSimilarity(trigramSets[idx]!, trigramSets[selIdx]!);
        if (sim > maxSim) maxSim = sim;
      }
      const score = lambda * rel - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }

    if (bestIdx === -1) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }

  return selected.map((i) => hits[i]!);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Set of character trigrams from a string. */
function trigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, " ").slice(0, 500); // cap for perf
  const result = new Set<string>();
  for (let i = 0; i + 2 < s.length; i++) {
    result.add(s.slice(i, i + 3));
  }
  return result;
}

/** Jaccard similarity between two sets. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
