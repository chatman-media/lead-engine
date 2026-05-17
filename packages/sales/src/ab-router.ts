import { createHash } from "node:crypto";

export interface ExperimentVariant {
  styleSlug: string;
  /** Integer weight — variants are normalized by total. e.g. 50/30/20. */
  weight: number;
}

export interface Experiment {
  slug: string;
  variants: readonly ExperimentVariant[];
}

/**
 * Deterministic A/B variant picker.
 *
 * Given the same `(experiment.slug, userId)` pair, always returns the same
 * styleSlug — so a prospect that comes back tomorrow gets the same persona,
 * and restart of the process doesn't reshuffle assignments.
 *
 * Distribution is proportional to `weight`. SHA-256 → first 4 bytes → mod total.
 */
export function pickVariant(
  experiment: Experiment,
  userId: string | number,
): string {
  if (experiment.variants.length === 0) {
    throw new Error(`Experiment "${experiment.slug}" has no variants`);
  }

  const total = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
  if (total <= 0) {
    throw new Error(`Experiment "${experiment.slug}" total weight must be > 0`);
  }

  const hash = createHash("sha256")
    .update(`${experiment.slug}:${userId}`)
    .digest();
  const n = hash.readUInt32BE(0) % total;

  let cumulative = 0;
  for (const variant of experiment.variants) {
    cumulative += variant.weight;
    if (n < cumulative) return variant.styleSlug;
  }

  const last = experiment.variants[experiment.variants.length - 1];
  if (!last) throw new Error(`Experiment "${experiment.slug}" has no variants`);
  return last.styleSlug;
}
