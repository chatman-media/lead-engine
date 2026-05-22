/**
 * Plan tier definitions + quota limits.
 *
 * Source-of-truth для всех plan-aware decisions: rate limits, channel count,
 * KB document count. `tenants.plan` строка в БД маппится в одну из этих
 * tier'ов; unknown plan → trated as `free` (safe fallback).
 *
 * Stripe price-IDs здесь же — но wire-up checkout-flow в отдельном PR.
 * Сейчас лимиты enforced при channel-create / kb-upload даже без Stripe
 * (для PoC: tenant вручную меняем `tenants.plan='pro'` через psql, не через UI).
 */

export type PlanKind = "free" | "starter" | "pro" | "enterprise";

export interface PlanLimits {
  /** Maximum active channels (telegram_bot / whatsapp / web). */
  maxChannels: number;
  /** Maximum KB documents. */
  maxKbDocuments: number;
  /** Inbound rate limit per minute (overrides env default if задан). */
  rateLimitPerMinute: number;
  /** Inbound rate limit per hour. */
  rateLimitPerHour: number;
  /** Display name для UI. */
  label: string;
  /** Месячная цена в USD (для UI; "—" для free / enterprise custom). */
  priceUsd: number | null;
  /** Stripe price ID для checkout (wire-up в M1b PR). null = manual provisioning. */
  stripePriceId: string | null;
}

const FREE: PlanLimits = {
  maxChannels: 1,
  maxKbDocuments: 50,
  rateLimitPerMinute: 30,
  rateLimitPerHour: 300,
  label: "Free",
  priceUsd: 0,
  stripePriceId: null,
};

const STARTER: PlanLimits = {
  maxChannels: 3,
  maxKbDocuments: 500,
  rateLimitPerMinute: 60,
  rateLimitPerHour: 600,
  label: "Starter",
  priceUsd: 49,
  stripePriceId: null, // TODO M1b: set from env STRIPE_PRICE_STARTER
};

const PRO: PlanLimits = {
  maxChannels: 10,
  maxKbDocuments: 10000,
  rateLimitPerMinute: 120,
  rateLimitPerHour: 2400,
  label: "Pro",
  priceUsd: 149,
  stripePriceId: null, // TODO M1b: set from env STRIPE_PRICE_PRO
};

const ENTERPRISE: PlanLimits = {
  // Эффективно unlimited; реальные tenants сидят на self-host deploy'е.
  maxChannels: 100,
  maxKbDocuments: 100000,
  rateLimitPerMinute: 600,
  rateLimitPerHour: 60000,
  label: "Enterprise",
  priceUsd: null,
  stripePriceId: null,
};

const PLANS: Record<PlanKind, PlanLimits> = {
  free: FREE,
  starter: STARTER,
  pro: PRO,
  enterprise: ENTERPRISE,
};

/**
 * Resolve plan string из БД в PlanLimits. Unknown plan → free fallback
 * с warning hook (для логирования misconfig).
 */
export function resolvePlan(
  planStr: string,
  onUnknown?: (plan: string) => void,
): PlanLimits {
  if (planStr in PLANS) return PLANS[planStr as PlanKind];
  onUnknown?.(planStr);
  return FREE;
}

/** Список всех известных plan tiers — для UI plan picker. */
export function allPlans(): Array<{ kind: PlanKind; limits: PlanLimits }> {
  return (Object.entries(PLANS) as [PlanKind, PlanLimits][]).map(([kind, limits]) => ({
    kind,
    limits,
  }));
}
