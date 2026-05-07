/**
 * Standard ELO update against a fixed 1500 baseline. We use this rather
 * than pairwise (style A vs style B) ELO because in single-style production
 * there's no live pair to compare against — but the rating still drifts
 * meaningfully up/down as the style accumulates wins/losses.
 *
 * When a second style enters production, swap to true pairwise via
 * `eloUpdatePair` (same K-factor, opponent rating from style_ratings instead
 * of fixed 1500).
 *
 * Math:
 *   expected = 1 / (1 + 10^((opp - self) / 400))
 *   delta    = K * (actual - expected)   where actual ∈ {1, 0.5, 0}
 *   new_self = self + delta              (rounded to integer)
 */
const DEFAULT_K = 32;
const BASELINE = 1500;

export type EloOutcome = "won" | "lost" | "draw";

export function actualScore(o: EloOutcome): 0 | 0.5 | 1 {
  if (o === "won") return 1;
  if (o === "lost") return 0;
  return 0.5;
}

export function expectedScore(self: number, opp: number): number {
  return 1 / (1 + 10 ** ((opp - self) / 400));
}

export function eloUpdate(
  current: number,
  outcome: EloOutcome,
  opts: { opponentRating?: number; k?: number } = {},
): number {
  const opp = opts.opponentRating ?? BASELINE;
  const k = opts.k ?? DEFAULT_K;
  const expected = expectedScore(current, opp);
  const actual = actualScore(outcome);
  return Math.round(current + k * (actual - expected));
}

/** Pairwise variant — applies symmetric updates, useful for self-play. */
export function eloUpdatePair(
  a: number,
  b: number,
  outcomeForA: EloOutcome,
  k: number = DEFAULT_K,
): { a: number; b: number } {
  const expectedA = expectedScore(a, b);
  const actualA = actualScore(outcomeForA);
  const newA = Math.round(a + k * (actualA - expectedA));
  const newB = Math.round(b + k * (1 - actualA - (1 - expectedA)));
  return { a: newA, b: newB };
}

export const ELO_BASELINE = BASELINE;
export const ELO_DEFAULT_K = DEFAULT_K;
