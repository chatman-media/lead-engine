import { adminInvites, earlyAccessSignups, tenants } from "@chatman-media/storage";
import { desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { deriveTenantSlug } from "../lib/auth.ts";
import { isUniqueViolation } from "../lib/db-errors.ts";

/**
 * Superadmin-only endpoints — доступны только пользователям с role='superadmin'.
 *
 *   GET  /api/superadmin/tenants         — список всех тенантов с метриками
 *   PATCH /api/superadmin/tenants/:id/plan — смена тарифного плана
 *   GET  /api/superadmin/early-access    — alpha-заявки
 *   POST /api/superadmin/early-access/:id/approve — создать tenant + invite
 */

export interface SuperadminRoutesOpts {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  db: PostgresJsDatabase<any>;
  /** Admin UI URL для `/accept-invite?token=...`. Если пуст — вернём relative URL. */
  publicUrl?: string;
}

const VALID_PLANS = ["free", "starter", "pro"] as const;
const DEFAULT_ALPHA_PLAN: (typeof VALID_PLANS)[number] = "starter";
const ALPHA_INVITE_EXPIRES_SEC = 30 * 24 * 60 * 60;

interface EarlyAccessApproveBody {
  plan?: unknown;
  tenantSlug?: unknown;
}

function genToken(): string {
  const buf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanBaseUrl(url?: string): string | null {
  if (!url) return null;
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

function inviteShareUrl(publicUrl: string | undefined, token: string): string {
  const path = `/accept-invite?token=${encodeURIComponent(token)}`;
  const base = cleanBaseUrl(publicUrl);
  return base ? `${base}${path}` : path;
}

function isValidTenantSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug);
}

async function getEarlyAccessItem(
  db: PostgresJsDatabase<any>,
  publicUrl: string | undefined,
  id?: number,
) {
  const baseQuery = db
    .select({
      id: earlyAccessSignups.id,
      email: earlyAccessSignups.email,
      name: earlyAccessSignups.name,
      company: earlyAccessSignups.company,
      useCase: earlyAccessSignups.useCase,
      source: earlyAccessSignups.source,
      locale: earlyAccessSignups.locale,
      status: earlyAccessSignups.status,
      tenantId: earlyAccessSignups.tenantId,
      inviteId: earlyAccessSignups.inviteId,
      approvedAt: earlyAccessSignups.approvedAt,
      approvedByAdminId: earlyAccessSignups.approvedByAdminId,
      createdAt: earlyAccessSignups.createdAt,
      updatedAt: earlyAccessSignups.updatedAt,
      tenantSlug: tenants.slug,
      tenantPlan: tenants.plan,
      inviteToken: adminInvites.token,
      inviteExpiresAt: adminInvites.expiresAt,
      inviteUsedAt: adminInvites.usedAt,
    })
    .from(earlyAccessSignups)
    .leftJoin(tenants, eq(earlyAccessSignups.tenantId, tenants.id))
    .leftJoin(adminInvites, eq(earlyAccessSignups.inviteId, adminInvites.id));

  const rows = await (id
    ? baseQuery.where(eq(earlyAccessSignups.id, id))
    : baseQuery.orderBy(desc(earlyAccessSignups.createdAt)));

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    company: row.company,
    useCase: row.useCase,
    source: row.source,
    locale: row.locale,
    status: row.status,
    tenantId: row.tenantId,
    tenantSlug: row.tenantSlug,
    tenantPlan: row.tenantPlan,
    inviteId: row.inviteId,
    inviteUrl: row.inviteToken ? inviteShareUrl(publicUrl, row.inviteToken) : null,
    inviteExpiresAt: row.inviteExpiresAt,
    inviteUsedAt: row.inviteUsedAt,
    approvedAt: row.approvedAt,
    approvedByAdminId: row.approvedByAdminId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

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

  app.get("/api/superadmin/early-access", async (c) => {
    const items = await getEarlyAccessItem(opts.db, opts.publicUrl);
    return c.json({ items });
  });

  app.post("/api/superadmin/early-access/:id/approve", async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    let body: EarlyAccessApproveBody = {};
    try {
      body = (await c.req.json()) as EarlyAccessApproveBody;
    } catch {
      body = {};
    }

    const planValue = typeof body.plan === "string" ? body.plan : DEFAULT_ALPHA_PLAN;
    if (!VALID_PLANS.includes(planValue as (typeof VALID_PLANS)[number])) {
      return c.json({ error: `plan must be one of: ${VALID_PLANS.join(", ")}` }, 400);
    }
    const plan = planValue as (typeof VALID_PLANS)[number];

    const customSlug =
      typeof body.tenantSlug === "string" && body.tenantSlug.trim()
        ? body.tenantSlug.trim().toLowerCase()
        : null;
    if (customSlug && !isValidTenantSlug(customSlug)) {
      return c.json({ error: "invalid tenantSlug (lowercase, a-z 0-9 -, 3-32 chars)" }, 400);
    }

    const [existing] = await getEarlyAccessItem(opts.db, opts.publicUrl, id);
    if (!existing) return c.json({ error: "early access request not found" }, 404);
    if (existing.tenantId && existing.inviteId) {
      return c.json({
        ok: true,
        item: existing,
        tenant: {
          id: existing.tenantId,
          slug: existing.tenantSlug,
          plan: existing.tenantPlan,
        },
        invite: {
          id: existing.inviteId,
          shareUrl: existing.inviteUrl,
          expiresAt: existing.inviteExpiresAt,
          usedAt: existing.inviteUsedAt,
        },
      });
    }

    let slug = customSlug ?? deriveTenantSlug(existing.email);
    let attempt = 0;
    let result: {
      tenant: { id: number; slug: string; plan: string };
      invite: { id: number; token: string; expiresAt: number; usedAt: number | null };
    } | null = null;

    while (attempt < 5 && !result) {
      attempt++;
      try {
        const nowEpoch = Math.floor(Date.now() / 1000);
        const token = genToken();
        const expiresAt = nowEpoch + ALPHA_INVITE_EXPIRES_SEC;

        result = await opts.db.transaction(async (tx) => {
          const [tenant] = await tx
            .insert(tenants)
            .values({
              slug,
              plan,
              status: "active",
              llmBillingMode: "byok",
              createdAt: nowEpoch,
              updatedAt: nowEpoch,
            })
            .returning({
              id: tenants.id,
              slug: tenants.slug,
              plan: tenants.plan,
            });
          if (!tenant) throw new Error("tenant insert failed");

          await tx.execute(sql.raw(`SET LOCAL app.tenant_id = ${tenant.id}`));

          const [invite] = await tx
            .insert(adminInvites)
            .values({
              tenantId: tenant.id,
              email: existing.email,
              role: "superadmin",
              token,
              invitedByAdminId: c.var.adminId,
              expiresAt,
              createdAt: nowEpoch,
            })
            .returning({
              id: adminInvites.id,
              token: adminInvites.token,
              expiresAt: adminInvites.expiresAt,
              usedAt: adminInvites.usedAt,
            });
          if (!invite) throw new Error("invite insert failed");

          await tx
            .update(earlyAccessSignups)
            .set({
              status: "approved",
              tenantId: tenant.id,
              inviteId: invite.id,
              approvedAt: nowEpoch,
              approvedByAdminId: c.var.adminId,
              updatedAt: nowEpoch,
            })
            .where(eq(earlyAccessSignups.id, id));

          return { tenant, invite };
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (customSlug) return c.json({ error: "tenantSlug already taken" }, 409);
          slug = deriveTenantSlug(existing.email);
          continue;
        }
        throw err;
      }
    }

    if (!result) {
      return c.json({ error: "could not allocate tenant slug after 5 attempts" }, 500);
    }

    const [item] = await getEarlyAccessItem(opts.db, opts.publicUrl, id);
    return c.json({
      ok: true,
      item,
      tenant: result.tenant,
      invite: {
        id: result.invite.id,
        shareUrl: inviteShareUrl(opts.publicUrl, result.invite.token),
        expiresAt: result.invite.expiresAt,
        usedAt: result.invite.usedAt,
      },
    });
  });

  app.patch("/api/superadmin/tenants/:id/plan", async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    let body: { plan?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
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
