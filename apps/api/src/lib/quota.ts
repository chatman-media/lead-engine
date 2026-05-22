/**
 * Plan-aware quota checks для admin-routes. Используется в channels POST
 * и KB documents POST чтобы не позволить tenant'у превысить лимит своего
 * plan tier'а.
 *
 * Failure mode: 402 Payment Required + structured response, UI отображает
 * "Upgrade your plan" CTA. Не 429 — это бы было misleading (не rate).
 */

import { type Db } from "@chatman-media/conversation-engine";
import { channels, kbDocuments, tenants } from "@chatman-media/storage";
import { count, eq } from "drizzle-orm";
import { type PlanKind, type PlanLimits, resolvePlan } from "./plans.ts";

export interface QuotaCheckResult {
  allowed: boolean;
  limit: number;
  current: number;
  plan: PlanKind;
  planLabel: string;
  reason?: "max_channels" | "max_kb_documents";
}

interface QuotaCheckOpts {
  db: Db;
  tenantId: number;
}

/**
 * Можно ли добавить ещё один канал? Запрашивает текущее count + plan.
 * `current + 1 > limit` → not allowed.
 */
export async function canAddChannel(opts: QuotaCheckOpts): Promise<QuotaCheckResult> {
  const { plan, currentCount, limits } = await loadPlanAndCount(opts, channels);
  const allowed = currentCount < limits.maxChannels;
  return {
    allowed,
    limit: limits.maxChannels,
    current: currentCount,
    plan,
    planLabel: limits.label,
    ...(allowed ? {} : { reason: "max_channels" as const }),
  };
}

/**
 * Можно ли upload новый KB document?
 */
export async function canAddKbDocument(opts: QuotaCheckOpts): Promise<QuotaCheckResult> {
  const { plan, currentCount, limits } = await loadPlanAndCount(opts, kbDocuments);
  const allowed = currentCount < limits.maxKbDocuments;
  return {
    allowed,
    limit: limits.maxKbDocuments,
    current: currentCount,
    plan,
    planLabel: limits.label,
    ...(allowed ? {} : { reason: "max_kb_documents" as const }),
  };
}

async function loadPlanAndCount(
  opts: QuotaCheckOpts,
  // biome-ignore lint/suspicious/noExplicitAny: drizzle pgTable union too broad для table generic
  table: any,
): Promise<{ plan: PlanKind; limits: PlanLimits; currentCount: number }> {
  const [tenant] = await opts.db
    .select({ plan: tenants.plan })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId));
  const planStr = tenant?.plan ?? "free";
  const limits = resolvePlan(planStr);

  const rows = await opts.db
    .select({ value: count() })
    .from(table)
    .where(eq(table.tenantId, opts.tenantId));

  return {
    plan: (planStr as PlanKind) in { free: 1, starter: 1, pro: 1, enterprise: 1 }
      ? (planStr as PlanKind)
      : "free",
    limits,
    currentCount: Number(rows[0]?.value ?? 0),
  };
}
