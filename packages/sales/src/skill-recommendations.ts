import type { SkillAggregate, SkillRow } from "./store.ts";

/**
 * Data-driven skill picker. Given the catalogue + per-skill outcome
 * aggregates, recommends a ranked subset using Wilson lower-bound
 * confidence intervals — so a skill with 3 wins out of 3 doesn't beat
 * a skill with 50 wins out of 60. Wilson handles small-sample
 * uncertainty cleanly.
 *
 * Use cases:
 *   1. /admin/styles/:id picker → "✨ Auto-select" prefill
 *   2. Future: per-stage recommendations once we attribute outcomes
 *      with stage info
 *
 * Design choices:
 *   - We score on (wins + draws/2) / total — draws count as half-win
 *     (consistent with ELO actual-score).
 *   - `noise` family is always excluded (it's our "this skill is bad"
 *     bucket — by design).
 *   - Disabled skills are filtered out (operator deliberately silenced).
 *   - Skills with `count < minSamples` get a confidence score of 0 so
 *     they sort at the bottom but stay in the response (UI can show
 *     them as low-confidence candidates).
 */

export interface SkillRecommendation {
  slug: string;
  display_name: string;
  family: string;
  /** Score = (wins + 0.5*draws) / count. NaN when count == 0. */
  observed_rate: number;
  /** Wilson 95% lower bound. Drives the rank. 0 when count < minSamples. */
  confidence_lower: number;
  count: number;
  wins: number;
  losses: number;
  draws: number;
  /** Whether the recommendation engine suggests attaching this skill.
   *  Derived from confidence_lower >= acceptThreshold + count >= minSamples. */
  recommended: boolean;
}

export interface RecommendOptions {
  /** Minimum sample count for confidence_lower to be non-zero. */
  minSamples?: number;
  /** Wilson lower bound that flips `recommended=true`. 0..1. */
  acceptThreshold?: number;
  /** Z-score for the Wilson interval. 1.96 ≈ 95% confidence. */
  z?: number;
}

const DEFAULTS = {
  minSamples: 5,
  acceptThreshold: 0.4,
  z: 1.96,
};

/**
 * Wilson score interval lower bound.
 *   p = wins/n
 *   lower = (p + z²/(2n) - z*sqrt((p(1-p) + z²/(4n))/n)) / (1 + z²/n)
 */
export function wilsonLowerBound(
  wins: number,
  total: number,
  z: number = DEFAULTS.z,
): number {
  if (total === 0) return 0;
  const p = wins / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (center - margin) / denom);
}

export function rankSkillRecommendations(
  catalogue: SkillRow[],
  aggregates: SkillAggregate[],
  opts: RecommendOptions = {},
): SkillRecommendation[] {
  const minSamples = opts.minSamples ?? DEFAULTS.minSamples;
  const acceptThreshold = opts.acceptThreshold ?? DEFAULTS.acceptThreshold;
  const z = opts.z ?? DEFAULTS.z;

  const aggBySlug = new Map(aggregates.map((a) => [a.skill_slug, a]));

  const out: SkillRecommendation[] = [];
  for (const skill of catalogue) {
    if (!skill.is_enabled) continue;
    if (skill.family === "noise") continue;
    const agg = aggBySlug.get(skill.slug);
    const wins = agg?.wins ?? 0;
    const losses = agg?.losses ?? 0;
    const draws = agg?.draws ?? 0;
    const count = agg?.count ?? 0;
    // Half-credit for draws — same convention ELO uses.
    const successCount = wins + 0.5 * draws;
    const observedRate = count > 0 ? successCount / count : Number.NaN;
    const confidenceLower =
      count >= minSamples ? wilsonLowerBound(successCount, count, z) : 0;
    out.push({
      slug: skill.slug,
      display_name: skill.display_name,
      family: skill.family,
      observed_rate: observedRate,
      confidence_lower: confidenceLower,
      count,
      wins,
      losses,
      draws,
      recommended: count >= minSamples && confidenceLower >= acceptThreshold,
    });
  }

  // Rank by confidence_lower DESC (best evidence first), tiebreak by
  // sample count DESC (more data = stronger signal).
  out.sort((a, b) => {
    if (b.confidence_lower !== a.confidence_lower) {
      return b.confidence_lower - a.confidence_lower;
    }
    return b.count - a.count;
  });
  return out;
}
