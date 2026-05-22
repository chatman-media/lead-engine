import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { channels, kbDocuments, tenants } from "@chatman-media/storage";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { allPlans, resolvePlan } from "../lib/plans.ts";

/**
 * Per-tenant billing & plan endpoints (M1a — без Stripe).
 *
 * Endpoints:
 *   GET /api/admin/billing/plan      — current plan + limits + usage
 *   GET /api/admin/billing/plans     — список всех доступных plan tier'ов
 *
 * Stripe checkout / portal / webhook live в отдельных endpoints (M1b PR).
 */
export interface AdminBillingRoutesOpts {
  db: Db;
}

export function makeAdminBillingRoutes(opts: AdminBillingRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/billing/plan
   * Returns:
   *   {
   *     plan: { kind, label, priceUsd, maxChannels, maxKbDocuments,
   *             rateLimitPerMinute, rateLimitPerHour },
   *     usage: { channels: N, kbDocuments: N },
   *     status: 'ok' | 'over_limit_channels' | 'over_limit_kb'
   *   }
   */
  app.get("/api/admin/billing/plan", async (c) => {
    const tenantId = c.var.tenantId;
    const data = await withTenant(opts.db, tenantId, async (tx) => {
      const [tenant] = await tx
        .select({ plan: tenants.plan })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      const channelRows = await tx
        .select({ value: count() })
        .from(channels)
        .where(eq(channels.tenantId, tenantId));
      const kbRows = await tx
        .select({ value: count() })
        .from(kbDocuments)
        .where(eq(kbDocuments.tenantId, tenantId));
      return {
        plan: tenant?.plan ?? "free",
        channelCount: Number(channelRows[0]?.value ?? 0),
        kbCount: Number(kbRows[0]?.value ?? 0),
      };
    });

    const limits = resolvePlan(data.plan);
    let status: "ok" | "over_limit_channels" | "over_limit_kb" = "ok";
    if (data.channelCount > limits.maxChannels) status = "over_limit_channels";
    else if (data.kbCount > limits.maxKbDocuments) status = "over_limit_kb";

    return c.json({
      plan: {
        kind: data.plan,
        label: limits.label,
        priceUsd: limits.priceUsd,
        maxChannels: limits.maxChannels,
        maxKbDocuments: limits.maxKbDocuments,
        rateLimitPerMinute: limits.rateLimitPerMinute,
        rateLimitPerHour: limits.rateLimitPerHour,
      },
      usage: {
        channels: data.channelCount,
        kbDocuments: data.kbCount,
      },
      status,
    });
  });

  /**
   * GET /api/admin/billing/plans
   * Returns: { plans: [{ kind, label, priceUsd, maxChannels, ... }] }
   *
   * Used by UI plan picker. Без auth-bypass — это per-tenant endpoint.
   */
  app.get("/api/admin/billing/plans", (c) => {
    return c.json({
      plans: allPlans().map(({ kind, limits }) => ({
        kind,
        label: limits.label,
        priceUsd: limits.priceUsd,
        maxChannels: limits.maxChannels,
        maxKbDocuments: limits.maxKbDocuments,
        rateLimitPerMinute: limits.rateLimitPerMinute,
      })),
    });
  });

  return app;
}
