/**
 * Plan-aware quota checks для admin-routes. Используется в channels POST
 * и KB documents POST чтобы не позволить tenant'у превысить лимит своего
 * plan tier'а.
 *
 * Failure mode: 402 Payment Required + structured response, UI отображает
 * "Upgrade your plan" CTA. Не 429 — это бы было misleading (не rate).
 */

import { type Db } from "@chatman-media/conversation-engine";
import { admins, channels, kbDocuments, leads, tenants } from "@chatman-media/storage";
import { count, eq } from "drizzle-orm";
import { type PlanKind, type PlanLimits, resolvePlan } from "./plans.ts";

export interface QuotaCheckResult {
  allowed: boolean;
  limit: number;
  current: number;
  plan: PlanKind;
  planLabel: string;
  reason?: "max_channels" | "max_kb_documents" | "max_admins" | "max_leads";
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

/**
 * Можно ли пригласить ещё одного admin?
 */
export async function canAddAdmin(opts: QuotaCheckOpts): Promise<QuotaCheckResult> {
  const [tenant] = await opts.db
    .select({ plan: tenants.plan })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId));
  const planStr = tenant?.plan ?? "free";
  const limits = resolvePlan(planStr);

  if (limits.maxAdmins === -1) {
    return {
      allowed: true,
      limit: -1,
      current: 0,
      plan: planStr as PlanKind,
      planLabel: limits.label,
    };
  }

  const rows = await opts.db
    .select({ value: count() })
    .from(admins)
    .where(eq(admins.tenantId, opts.tenantId));
  const currentCount = Number(rows[0]?.value ?? 0);
  const allowed = currentCount < limits.maxAdmins;
  return {
    allowed,
    limit: limits.maxAdmins,
    current: currentCount,
    plan: planStr as PlanKind,
    planLabel: limits.label,
    ...(allowed ? {} : { reason: "max_admins" as const }),
  };
}

/**
 * Можно ли создать ещё один лид?
 */
export async function canAddLead(opts: QuotaCheckOpts): Promise<QuotaCheckResult> {
  const [tenant] = await opts.db
    .select({ plan: tenants.plan })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId));
  const planStr = tenant?.plan ?? "free";
  const limits = resolvePlan(planStr);

  if (limits.maxLeads === -1) {
    return {
      allowed: true,
      limit: -1,
      current: 0,
      plan: planStr as PlanKind,
      planLabel: limits.label,
    };
  }

  const rows = await opts.db
    .select({ value: count() })
    .from(leads)
    .where(eq(leads.tenantId, opts.tenantId));
  const currentCount = Number(rows[0]?.value ?? 0);
  const allowed = currentCount < limits.maxLeads;
  return {
    allowed,
    limit: limits.maxLeads,
    current: currentCount,
    plan: planStr as PlanKind,
    planLabel: limits.label,
    ...(allowed ? {} : { reason: "max_leads" as const }),
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
    plan:
      (planStr as PlanKind) in { free: 1, starter: 1, pro: 1, enterprise: 1 }
        ? (planStr as PlanKind)
        : "free",
    limits,
    currentCount: Number(rows[0]?.value ?? 0),
  };
}
