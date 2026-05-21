import type { KbSearchHit } from "./types.ts";

/**
 * Reciprocal Rank Fusion — fuses two ranked result lists into one.
 *
 * Standard formula: score(d) = Σ 1/(k + rank(d))
 * where k=60 is the smoothing constant (Cormack et al., 2009).
 *
 * Returns hits sorted by descending fused score. The `distance` field is
 * remapped to `1 - score` so callers get a consistent "lower = better"
 * interpretation regardless of whether the underlying search was vector or BM25.
 *
 * @param vectorHits  Results from vector (cosine) search, ranked by ascending distance.
 * @param bm25Hits    Results from BM25 search, ranked by descending BM25 score.
 * @param k           Number of top results to return.
 * @param rrfK        RRF smoothing constant (default 60).
 */
export function reciprocalRankFusion(
  vectorHits: KbSearchHit[],
  bm25Hits: KbSearchHit[],
  k: number,
  rrfK = 60,
): KbSearchHit[] {
  if (bm25Hits.length === 0) return vectorHits.slice(0, k);
  if (vectorHits.length === 0) return bm25Hits.slice(0, k);

  const scores = new Map<number, { hit: KbSearchHit; score: number }>();

  const addRanked = (hits: KbSearchHit[]) => {
    hits.forEach((h, i) => {
      const rank = i + 1;
      const inc = 1 / (rrfK + rank);
      const prev = scores.get(h.chunk_id);
      if (prev) {
        prev.score += inc;
      } else {
        scores.set(h.chunk_id, { hit: h, score: inc });
      }
    });
  };

  addRanked(vectorHits);
  addRanked(bm25Hits);

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ hit, score }) => ({ ...hit, distance: 1 - score }));
}

/**
 * Sanitizes a raw user query into a valid PostgreSQL `tsquery` string for
 * Russian full-text search. Uses prefix-OR semantics (`term:* OR term:*`)
 * so partial words and morphological variants match without a stemming dict.
 *
 * Strips tsquery operator characters to prevent injection:
 * `"`, `'`, `(`, `)`, `*`, `:`, `.`, `\\`, `^`, `&`, `|`, `!`
 * and boolean keywords `AND`, `OR`, `NOT`, `NEAR`.
 *
 * Returns an empty string when the query contains no usable tokens (caller
 * should skip the FTS query entirely in that case).
 *
 * @example
 * sanitizeFtsQuery("виза оформляется")
 * // → "виза:* | оформляется:*"
 *
 * sanitizeFtsQuery('OR "injection"')
 * // → "injection:*"
 */
const FTS_KEYWORDS = new Set(["and", "or", "not", "near"]);

export function sanitizeFtsQuery(raw: string): string {
  if (!raw) return "";
  const stripped = raw.replace(/["'()*:.\\^&|!]/g, " ");
  const tokens = stripped
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !FTS_KEYWORDS.has(t.toLowerCase()));
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}:*`).join(" | ");
}
