// Admin-API routes — поверхность для apps/admin-ui (React SPA). Tenant-
// scoped по subdomain через makeTenantContextMiddleware (P из Issue #3).
// Все endpoints'ы под /admin/* требуют resolved tenant; apex-routes (login,
// landing) живут отдельно.
//
// Auth (отложен): сейчас все endpoint'ы публичны. Полноценный JWT/session
// flow добавляется когда apps/admin-ui начнёт wire-up'аться:
//   - POST /admin/login (apex) — email+password → JWT с tenantId+adminId
//   - middleware requireAdminSession — проверяет JWT на каждом /admin/*
//   - JWT включает tenantId — verify'им что matches resolved tenantSlug
//
// Сейчас этот файл — skeleton: возвращает stub-данные с прикреплённым
// tenant.slug. Когда auth'а добавится, добавится adminId в response'ы
// и UI получит whoami из /admin/me.

import {
  ContactsRepo,
  ConversationsRepo,
  type Db,
  ExperimentsRepo,
  LeadsRepo,
  MessagesRepo,
  SkillOutcomesRepo,
  StylesRepo,
  withTenant,
} from "@chatman-media/conversation-engine";
import { tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";

export interface AdminRoutesOpts {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic — apps/api держит конкретный schema
  db: PostgresJsDatabase<any>;
}

export function makeAdminRoutes(opts: AdminRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /admin/tenant — info о текущем tenant'е (из subdomain).
   * apps/admin-ui дёргает один раз на boot и кэширует.
   */
  app.get("/admin/tenant", async (c) => {
    const slug = c.var.tenantSlug!;
    const [row] = await opts.db
      .select()
      .from(tenants)
      .where(and(eq(tenants.slug, slug), eq(tenants.status, "active")));
    if (!row) return c.json({ error: "tenant not found" }, 404);
    return c.json({
      id: row.id,
      slug: row.slug,
      plan: row.plan,
      status: row.status,
      llmBillingMode: row.llmBillingMode,
      createdAt: row.createdAt,
    });
  });

  /**
   * GET /admin/me — whoami. После auth — JWT-clains; сейчас — заглушка
   * чтобы UI имел стабильный shape ответа.
   */
  app.get("/admin/me", async (c) => {
    return c.json({
      tenantSlug: c.var.tenantSlug,
      // Заполнятся при добавлении auth:
      adminId: null,
      email: null,
      role: null,
    });
  });

  // NB: каждый handler ниже после resolveTenantId оборачивает repo-вызовы
  // в withTenant. На non-BYPASSRLS production role'и (см. миграцию 0004
  // + checkRlsEnforcement в apps/api/src/index.ts) policy tenant_isolation
  // отрезала бы SELECT'ы без `SET LOCAL app.tenant_id`. Без обёртки
  // admin-API на проде вернул бы пустые списки для любого tenant'а —
  // самая стрёмная категория молчаливых багов.

  /**
   * GET /admin/conversations?limit=50 — последние conversations tenant'а.
   * Для inbox-view UI.
   */
  app.get("/admin/conversations", async (c) => {
    const tenantId = await resolveTenantId(opts.db, c.var.tenantSlug!);
    if (tenantId === null) return c.json({ error: "tenant not found" }, 404);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
    const rows = await withTenant(opts.db as Db, tenantId, async (tx) => {
      const conversations = new ConversationsRepo({ db: tx, tenantId });
      return conversations.recent(limit);
    });
    return c.json({ tenantId, items: rows });
  });

  /**
   * GET /admin/conversations/:id/messages?limit=100 — full transcript.
   */
  app.get("/admin/conversations/:id/messages", async (c) => {
    const tenantId = await resolveTenantId(opts.db, c.var.tenantSlug!);
    if (tenantId === null) return c.json({ error: "tenant not found" }, 404);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "100"), 1), 1000);
    const rows = await withTenant(opts.db as Db, tenantId, async (tx) => {
      const messages = new MessagesRepo({ db: tx, tenantId });
      return messages.recent(id, limit);
    });
    return c.json({ conversationId: id, items: rows });
  });

  /**
   * GET /admin/contacts/:id — contact с attributes_json.
   */
  app.get("/admin/contacts/:id", async (c) => {
    const tenantId = await resolveTenantId(opts.db, c.var.tenantSlug!);
    if (tenantId === null) return c.json({ error: "tenant not found" }, 404);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const row = await withTenant(opts.db as Db, tenantId, async (tx) => {
      const contacts = new ContactsRepo({ db: tx, tenantId });
      return contacts.byId(id);
    });
    if (!row) return c.json({ error: "contact not found" }, 404);
    return c.json(row);
  });

  /**
   * GET /admin/leads/:id — lead с visa_docs_json.
   */
  app.get("/admin/leads/:id", async (c) => {
    const tenantId = await resolveTenantId(opts.db, c.var.tenantSlug!);
    if (tenantId === null) return c.json({ error: "tenant not found" }, 404);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const row = await withTenant(opts.db as Db, tenantId, async (tx) => {
      const leads = new LeadsRepo({ db: tx, tenantId });
      return leads.byId(id);
    });
    if (!row) return c.json({ error: "lead not found" }, 404);
    return c.json(row);
  });

  /**
   * GET /admin/styles — list active styles tenant'а (для experiment-builder
   * dropdown в admin-UI).
   */
  app.get("/admin/styles", async (c) => {
    const tenantId = await resolveTenantId(opts.db, c.var.tenantSlug!);
    if (tenantId === null) return c.json({ error: "tenant not found" }, 404);
    const rows = await withTenant(opts.db as Db, tenantId, async (tx) => {
      const styles = new StylesRepo({ db: tx, tenantId });
      return styles.listActive();
    });
    return c.json({ items: rows });
  });

  /**
   * GET /admin/experiments — list experiments tenant'а с current status.
   */
  app.get("/admin/experiments", async (c) => {
    const tenantId = await resolveTenantId(opts.db, c.var.tenantSlug!);
    if (tenantId === null) return c.json({ error: "tenant not found" }, 404);
    const rows = await withTenant(opts.db as Db, tenantId, async (tx) => {
      const experiments = new ExperimentsRepo({ db: tx, tenantId });
      return experiments.listAll();
    });
    return c.json({ items: rows });
  });

  /**
   * GET /admin/skills/aggregates — win/loss/draw per skill для coach-UI
   * (Issue #3 / K).
   */
  app.get("/admin/skills/aggregates", async (c) => {
    const tenantId = await resolveTenantId(opts.db, c.var.tenantSlug!);
    if (tenantId === null) return c.json({ error: "tenant not found" }, 404);
    const items = await withTenant(opts.db as Db, tenantId, async (tx) => {
      const repo = new SkillOutcomesRepo({ db: tx, tenantId });
      return repo.aggregates();
    });
    return c.json({ items });
  });

  return app;
}

async function resolveTenantId(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  db: PostgresJsDatabase<any>,
  slug: string,
): Promise<number | null> {
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.slug, slug), eq(tenants.status, "active")));
  return row?.id ?? null;
}
