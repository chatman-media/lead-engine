import type { Style } from "../types.ts";
import { coldDirectPas } from "./cold-direct-pas.ts";
import { empatheticNepq } from "./empathetic-nepq.ts";
import { flirtyBelfort } from "./flirty-belfort.ts";
import { marinaPrime } from "./marina-prime.ts";

/**
 * In-memory style registry. For Phase 1 (env-flag opt-in) this is the source
 * of truth. For Phase 2, swap to a SQLite-backed `styles` table loaded at boot.
 */
export const STYLES: readonly Style[] = [
  marinaPrime,
  flirtyBelfort,
  empatheticNepq,
  coldDirectPas,
];

export function listStyles(): readonly Style[] {
  return STYLES;
}

export function getStyle(slug: string): Style | undefined {
  return STYLES.find((s) => s.slug === slug);
}

export function getStyleOrThrow(slug: string): Style {
  const found = getStyle(slug);
  if (!found) {
    const known = STYLES.map((s) => s.slug).join(", ");
    throw new Error(`Style not found: "${slug}". Known styles: ${known}`);
  }
  return found;
}
