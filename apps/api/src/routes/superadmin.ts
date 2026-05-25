import { tenants } from "@chatman-media/storage";
import { count, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";

/**
 * Superadmin-only endpoints — доступны только пользователям с role='superadmin'.
 *
 *   GET  /api/superadmin/tenants         — список всех тенантов с метриками
 *   PATCH /api/superadmin/tenants/:id/plan — смена тарифного плана
 */

export interface SuperadminRoutesOpts {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  db: PostgresJsDatabase<any>;
}

const VALID_PLANS = ["free", "starter", "pro"] as const;

export function makeSuperadminRoutes(opts: SuperadminRoutesOpts): Hono {
  const app = new Hono();

  // Guard: все маршруты требуют role=superadmin.
  app.use("/api/superadmin/*", async (c, next) => {
    if (c.var.role !== "superadmin") return c.json({ error: "forbidden" }, 403);
    await next();
  });

  app.get("/api/superadmin/tenants", async (c) => {
    const rows = await opts.db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        plan: tenants.plan,
        status: tenants.status,
        createdAt: tenants.createdAt,
        ownerEmail: sql<string | null>`(
          SELECT email FROM admins
          WHERE tenant_id = ${tenants.id}
          ORDER BY id ASC LIMIT 1
        )`,
        leadCount: sql<number>`(
          SELECT COUNT(*)::int FROM leads WHERE tenant_id = ${tenants.id}
        )`,
        conversationCount: sql<number>`(
          SELECT COUNT(*)::int FROM conversations WHERE tenant_id = ${tenants.id}
        )`,
      })
      .from(tenants)
      .orderBy(sql`${tenants.createdAt} DESC`);

    return c.json({ items: rows });
  });

  app.patch("/api/superadmin/tenants/:id/plan", async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    let body: { plan?: unknown };
    try { body = (await c.req.json()) as typeof body; } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const plan = typeof body.plan === "string" ? body.plan : "";
    if (!VALID_PLANS.includes(plan as (typeof VALID_PLANS)[number])) {
      return c.json({ error: `plan must be one of: ${VALID_PLANS.join(", ")}` }, 400);
    }

    const [updated] = await opts.db
      .update(tenants)
      .set({ plan, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tenants.id, id))
      .returning({ id: tenants.id, slug: tenants.slug, plan: tenants.plan });

    if (!updated) return c.json({ error: "tenant not found" }, 404);
    return c.json(updated);
  });

  return app;
}
