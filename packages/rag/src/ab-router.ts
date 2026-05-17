import type { AnswerTelemetry } from "./answer-types.ts";
import type { Style } from "./styles.ts";

export interface ABVariant {
  /** Weight relative to other variants. Default 1. */
  weight?: number;
  style: Style;
}

export interface ABRouterOptions {
  variants: ABVariant[];
  /**
   * Called after every answer with the assigned variant slug and telemetry.
   * Use this to log impressions, latency, and conversion signals to your DB.
   */
  onResult?: (variantSlug: string, telemetry: AnswerTelemetry) => void;
  /**
   * Salt added to the userId before hashing. Change it to re-randomise
   * assignments without changing user ids.
   */
  salt?: string;
}

/**
 * Deterministic A/B style router.
 *
 * Assigns each user to a variant by hashing `userId + salt` — the same user
 * always gets the same variant within an experiment. Weights are respected:
 * a variant with weight 2 gets twice as many users as one with weight 1.
 *
 * Pass the returned `style` directly to `answerWithRag`. Log results via
 * `onResult` to measure conversion by variant.
 *
 * @example
 * ```ts
 * import { ABRouter, answerWithRag } from "@chatman-media/rag";
 *
 * const router = new ABRouter({
 *   variants: [
 *     { style: nepqStyle,         weight: 1 },
 *     { style: straightLineStyle, weight: 1 },
 *   ],
 *   onResult: (slug, telemetry) => db.logImpression(slug, telemetry),
 * });
 *
 * const { style, onTelemetry } = router.assign(userId);
 * const result = await answerWithRag({ question, kb, chat, embedder, style, onTelemetry });
 * ```
 */
export class ABRouter {
  private readonly variants: Required<ABVariant>[];
  private readonly totalWeight: number;
  private readonly onResult: ABRouterOptions["onResult"];
  private readonly salt: string;

  constructor(opts: ABRouterOptions) {
    if (opts.variants.length === 0) throw new Error("ABRouter: at least one variant required");
    this.variants = opts.variants.map((v) => ({ weight: v.weight ?? 1, style: v.style }));
    this.totalWeight = this.variants.reduce((s, v) => s + v.weight, 0);
    this.onResult = opts.onResult;
    this.salt = opts.salt ?? "";
  }

  /**
   * Assign a user to a variant. Returns the `style` to pass to `answerWithRag`
   * and an `onTelemetry` callback that forwards results to `opts.onResult`.
   */
  assign(userId: string): {
    style: Style;
    variantSlug: string;
    onTelemetry: (t: AnswerTelemetry) => void;
  } {
    const style = this.pickVariant(userId);
    const variantSlug = style.slug;
    const onResult = this.onResult;

    return {
      style,
      variantSlug,
      onTelemetry: (telemetry: AnswerTelemetry) => {
        onResult?.(variantSlug, telemetry);
      },
    };
  }

  /** Distribution map — slug → fraction of users assigned. */
  get distribution(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const v of this.variants) {
      out[v.style.slug] = v.weight / this.totalWeight;
    }
    return out;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private pickVariant(userId: string): Style {
    const hash = simpleHash(userId + this.salt);
    const bucket = ((hash % this.totalWeight) + this.totalWeight) % this.totalWeight;
    let cumulative = 0;
    for (const v of this.variants) {
      cumulative += v.weight;
      if (bucket < cumulative) return v.style;
    }
    // Fallback — should never be reached
    return (this.variants[this.variants.length - 1] as Required<ABVariant>).style;
  }
}

/** Fast non-cryptographic integer hash (FNV-1a 32-bit). */
function simpleHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}
