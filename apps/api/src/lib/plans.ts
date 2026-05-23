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
  /** Maximum admin team members (including superadmin). -1 = unlimited. */
  maxAdmins: number;
  /** Maximum active leads. -1 = unlimited. */
  maxLeads: number;
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

// Phase 1 pricing (recruitment-first ICP, ARPU $99-299):
// - Free: trial limits, conversion funnel only (1 channel, 50 docs, 30 msg/min,
//   100 LLM-replied msgs/мес мягкое ограничение через rate-limit cap'ы).
// - Starter $99: solo рекрутер / 1-2 человека (3 каналов, 500 docs, 60 msg/min).
// - Pro $199: команда recruitment-агентства (10 каналов, 10K docs, 120 msg/min).
// - Enterprise: self-host / custom (Phase 3+).
//
// Phase 1 ARPU pivot (старые $49/$149 → $99/$199): recruitment-агентства
// ОК платят $100+ за tool который заменяет ручную работу оператора. $49 был
// SMB-anchor от Tidio/Chatbase — низковато для нашего persuasion-engine USP.
// Если Phase 2 (real-estate) или Phase 3 (broader CX) — pricing revisited.
const FREE: PlanLimits = {
  maxChannels: 1,
  maxKbDocuments: 50,
  maxAdmins: 3,
  maxLeads: 100,
  rateLimitPerMinute: 20,
  rateLimitPerHour: 200,
  label: "Free",
  priceUsd: 0,
  stripePriceId: null,
};

const STARTER: PlanLimits = {
  maxChannels: 3,
  maxKbDocuments: 500,
  maxAdmins: 3,
  maxLeads: 1000,
  rateLimitPerMinute: 60,
  rateLimitPerHour: 600,
  label: "Starter",
  priceUsd: 99,
  stripePriceId: null, // env STRIPE_PRICE_STARTER, см. apps/api/src/index.ts wire-up
};

const PRO: PlanLimits = {
  maxChannels: 10,
  maxKbDocuments: 10000,
  maxAdmins: 10,
  maxLeads: -1, // unlimited
  rateLimitPerMinute: 120,
  rateLimitPerHour: 2400,
  label: "Pro",
  priceUsd: 199,
  stripePriceId: null, // env STRIPE_PRICE_PRO
};

const ENTERPRISE: PlanLimits = {
  // Эффективно unlimited; реальные tenants сидят на self-host deploy'е.
  maxChannels: 100,
  maxKbDocuments: 100000,
  maxAdmins: -1,
  maxLeads: -1,
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
