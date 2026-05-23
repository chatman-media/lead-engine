import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { vacancies } from "@chatman-media/storage";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

/**
 * Vacancies CRUD API.
 *
 * GET    /api/admin/vacancies          — список вакансий (активные сверху)
 * POST   /api/admin/vacancies          — создать вакансию
 * PATCH  /api/admin/vacancies/:id      — обновить
 * DELETE /api/admin/vacancies/:id      — удалить (hard delete)
 */
export interface AdminVacanciesRoutesOpts {
  db: Db;
}

export function makeAdminVacanciesRoutes(opts: AdminVacanciesRoutesOpts): Hono {
  const app = new Hono();

  /** GET /api/admin/vacancies */
  app.get("/api/admin/vacancies", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(vacancies)
        .where(eq(vacancies.tenantId, tenantId))
        .orderBy(desc(vacancies.isActive), desc(vacancies.updatedAt)),
    );
    return c.json({ items: rows });
  });

  /** POST /api/admin/vacancies */
  app.post("/api/admin/vacancies", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const body = await c.req.json<{
      title: string;
      body: string;
      url?: string;
      isActive?: boolean;
    }>();

    if (!body.title?.trim()) return c.json({ error: "title required" }, 400);
    if (!body.body?.trim()) return c.json({ error: "body required" }, 400);

    const now = Math.floor(Date.now() / 1000);
    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(vacancies)
        .values({
          tenantId,
          title: body.title.trim(),
          body: body.body.trim(),
          url: body.url?.trim() || null,
          isActive: body.isActive ?? true,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "vacancy.created",
      targetKind: "vacancy",
      targetId: String(row!.id),
      details: { title: body.title },
    });

    return c.json(row, 201);
  });

  /** PATCH /api/admin/vacancies/:id */
  app.patch("/api/admin/vacancies/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    const body = await c.req.json<{
      title?: string;
      body?: string;
      url?: string | null;
      isActive?: boolean;
    }>();

    const now = Math.floor(Date.now() / 1000);
    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(vacancies)
        .set({
          ...(body.title !== undefined ? { title: body.title.trim() } : {}),
          ...(body.body !== undefined ? { body: body.body.trim() } : {}),
          ...(body.url !== undefined ? { url: body.url?.trim() || null } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          updatedAt: now,
        })
        .where(and(eq(vacancies.id, id), eq(vacancies.tenantId, tenantId)))
        .returning(),
    );

    if (!row) return c.json({ error: "not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "vacancy.updated",
      targetKind: "vacancy",
      targetId: String(id),
      details: body,
    });

    return c.json(row);
  });

  /** DELETE /api/admin/vacancies/:id */
  app.delete("/api/admin/vacancies/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .delete(vacancies)
        .where(and(eq(vacancies.id, id), eq(vacancies.tenantId, tenantId))),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "vacancy.deleted",
      targetKind: "vacancy",
      targetId: String(id),
      details: {},
    });

    return c.json({ ok: true });
  });

  return app;
}
