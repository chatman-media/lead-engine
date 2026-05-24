/**
 * Superadmin API — платформенный операторский интерфейс.
 *
 * Защита: Bearer <PLATFORM_SUPERADMIN_TOKEN> (env). Не привязан к
 * tenant-сессии — это отдельный платформенный ключ.
 *
 * Endpoints:
 *   GET  /api/superadmin/tenants          — список всех тенантов
 *   PATCH /api/superadmin/tenants/:id/plan — ручная смена плана
 *   GET  /api/superadmin/stats            — агрегированная сводка
 */

import { admins, channels, stripeSubscriptions, tenants } from "@chatman-media/storage";
import { count, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";

export interface SuperadminRoutesOpts {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  db: PostgresJsDatabase<any>;
  /** PLATFORM_SUPERADMIN_TOKEN. Если пуст — роуты не регистрируются (caller skip'ает). */
  token: string;
}

const VALID_PLANS = ["free", "starter", "pro", "enterprise"] as const;

export function makeSuperadminRoutes(opts: SuperadminRoutesOpts): Hono {
  const app = new Hono();

  /** Auth middleware: Bearer <token> */
  app.use("/api/superadmin/*", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || provided !== opts.token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  /**
   * GET /api/superadmin/tenants
   * Returns: { items: TenantRow[], total: number }
   *
   * Каждый item:
   *   id, slug, plan, status, createdAt, updatedAt,
   *   adminCount, channelCount, stripeStatus
   */
  app.get("/api/superadmin/tenants", async (c) => {
    const limitStr = c.req.query("limit") ?? "50";
    const offsetStr = c.req.query("offset") ?? "0";
    const limit = Math.min(200, Math.max(1, Number.parseInt(limitStr, 10) || 50));
    const offset = Math.max(0, Number.parseInt(offsetStr, 10) || 0);

    const rows = await opts.db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        plan: tenants.plan,
        status: tenants.status,
        llmBillingMode: tenants.llmBillingMode,
        referredByCode: tenants.referredByCode,
        createdAt: tenants.createdAt,
        updatedAt: tenants.updatedAt,
      })
      .from(tenants)
      .orderBy(desc(tenants.createdAt))
      .limit(limit)
      .offset(offset);

    // Обогащаем каждый tenant count'ами (admin, channel).
    const enriched = await Promise.all(
      rows.map(async (t) => {
        const [adminRow] = await opts.db
          .select({ cnt: count() })
          .from(admins)
          .where(eq(admins.tenantId, t.id));
        const [channelRow] = await opts.db
          .select({ cnt: count() })
          .from(channels)
          .where(eq(channels.tenantId, t.id));
        const [subRow] = await opts.db
          .select({ status: stripeSubscriptions.status })
          .from(stripeSubscriptions)
          .where(eq(stripeSubscriptions.tenantId, t.id))
          .orderBy(desc(stripeSubscriptions.createdAt))
          .limit(1);
        return {
          ...t,
          adminCount: adminRow?.cnt ?? 0,
          channelCount: channelRow?.cnt ?? 0,
          stripeStatus: subRow?.status ?? null,
        };
      }),
    );

    const [totalRow] = await opts.db.select({ cnt: count() }).from(tenants);

    return c.json({ items: enriched, total: totalRow?.cnt ?? 0, limit, offset });
  });

  /**
   * GET /api/superadmin/tenants/:id
   * Returns single tenant with enriched info + admin emails.
   */
  app.get("/api/superadmin/tenants/:id", async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!id) return c.json({ error: "invalid id" }, 400);

    const [tenant] = await opts.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, id));
    if (!tenant) return c.json({ error: "tenant not found" }, 404);

    const adminRows = await opts.db
      .select({ id: admins.id, email: admins.email, role: admins.role, createdAt: admins.createdAt })
      .from(admins)
      .where(eq(admins.tenantId, id))
      .orderBy(admins.createdAt);

    const channelRows = await opts.db
      .select({ id: channels.id, kind: channels.kind, externalId: channels.externalId, status: channels.status })
      .from(channels)
      .where(eq(channels.tenantId, id));

    const subRows = await opts.db
      .select()
      .from(stripeSubscriptions)
      .where(eq(stripeSubscriptions.tenantId, id))
      .orderBy(desc(stripeSubscriptions.createdAt));

    return c.json({ tenant, admins: adminRows, channels: channelRows, subscriptions: subRows });
  });

  /**
   * PATCH /api/superadmin/tenants/:id/plan
   * Body: { plan: "free"|"starter"|"pro"|"enterprise" }
   * Опционально: { status: "active"|"suspended" }
   *
   * Используется для: ручного trial extension, скидок, debugging.
   */
  app.patch("/api/superadmin/tenants/:id/plan", async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!id) return c.json({ error: "invalid id" }, 400);

    let body: { plan?: unknown; status?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const updates: Record<string, unknown> = {
      updatedAt: Math.floor(Date.now() / 1000),
    };

    if (body.plan !== undefined) {
      if (!VALID_PLANS.includes(body.plan as (typeof VALID_PLANS)[number])) {
        return c.json({ error: `plan must be one of: ${VALID_PLANS.join(", ")}` }, 400);
      }
      updates.plan = body.plan;
    }

    if (body.status !== undefined) {
      if (!["active", "suspended", "deleted"].includes(body.status as string)) {
        return c.json({ error: "status must be: active, suspended, or deleted" }, 400);
      }
      updates.status = body.status;
    }

    if (Object.keys(updates).length === 1) {
      return c.json({ error: "nothing to update — provide plan or status" }, 400);
    }

    const [updated] = await opts.db
      .update(tenants)
      .set(updates)
      .where(eq(tenants.id, id))
      .returning({ id: tenants.id, slug: tenants.slug, plan: tenants.plan, status: tenants.status });

    if (!updated) return c.json({ error: "tenant not found" }, 404);

    return c.json({ ok: true, tenant: updated });
  });

  /**
   * GET /api/superadmin/stats
   * Агрегированная сводка для платформенного дашборда.
   */
  app.get("/api/superadmin/stats", async (c) => {
    const [totalTenants] = await opts.db.select({ cnt: count() }).from(tenants);
    const planCounts = await opts.db
      .select({ plan: tenants.plan, cnt: count() })
      .from(tenants)
      .groupBy(tenants.plan);
    const [totalChannels] = await opts.db.select({ cnt: count() }).from(channels);
    const [activeSubs] = await opts.db
      .select({ cnt: count() })
      .from(stripeSubscriptions)
      .where(eq(stripeSubscriptions.status, "active"));

    // Новые тенанты за последние 7 дней.
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const [newThisWeek] = await opts.db
      .select({ cnt: count() })
      .from(tenants)
      .where(sql`${tenants.createdAt} >= ${weekAgo}`);

    return c.json({
      totalTenants: totalTenants?.cnt ?? 0,
      newThisWeek: newThisWeek?.cnt ?? 0,
      totalChannels: totalChannels?.cnt ?? 0,
      activeSubscriptions: activeSubs?.cnt ?? 0,
      byPlan: Object.fromEntries(planCounts.map((p) => [p.plan, p.cnt])),
    });
  });

  return app;
}
