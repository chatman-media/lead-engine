import { type Db, StylesRepo, withTenant } from "@chatman-media/conversation-engine";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

/**
 * Styles CRUD — tenant-specific sales personas / communication frameworks.
 *
 * Endpoints:
 *   GET    /api/admin/styles        — список всех не-удалённых стилей тенанта
 *   POST   /api/admin/styles        — создать стиль
 *   PATCH  /api/admin/styles/:id    — обновить стиль
 *   DELETE /api/admin/styles/:id    — soft-delete стиль
 */
export interface AdminStylesRoutesOpts {
  db: Db;
}

export function makeAdminStylesRoutes(opts: AdminStylesRoutesOpts): Hono {
  const app = new Hono();

  app.get("/api/admin/styles", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new StylesRepo({ db: tx, tenantId });
      return repo.listAll();
    });
    return c.json({ items: rows });
  });

  /**
   * POST /api/admin/styles
   * Body: { displayName, slug, configJson, isActive? }
   */
  app.post("/api/admin/styles", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;

    let body: { displayName?: unknown; slug?: unknown; configJson?: unknown; isActive?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    const configJson = typeof body.configJson === "string" ? body.configJson : "{}";
    const isActive = body.isActive !== false;

    if (!displayName) return c.json({ error: "displayName required" }, 400);
    if (!slug || !/^[a-z0-9_-]+$/.test(slug)) {
      return c.json({ error: "slug required, only a-z 0-9 _ -" }, 400);
    }

    try {
      JSON.parse(configJson);
    } catch {
      return c.json({ error: "configJson must be valid JSON" }, 400);
    }

    let row: Awaited<ReturnType<StylesRepo["create"]>>;
    try {
      row = await withTenant(opts.db, tenantId, async (tx) => {
        const repo = new StylesRepo({ db: tx, tenantId });
        return repo.create({ slug, displayName, configJson, isActive });
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("uniq_styles_active_slug") || msg.includes("unique")) {
        return c.json({ error: "style with this slug already exists" }, 409);
      }
      throw err;
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "style.create",
      targetKind: "style",
      targetId: row.id,
      details: { slug, displayName },
    });

    return c.json(row, 201);
  });

  /**
   * PATCH /api/admin/styles/:id
   * Body: { displayName?, configJson?, isActive? }
   */
  app.patch("/api/admin/styles/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    let body: { displayName?: unknown; configJson?: unknown; isActive?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const patch: Parameters<StylesRepo["update"]>[1] = {};
    if (typeof body.displayName === "string") patch.displayName = body.displayName.trim();
    if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
    if (typeof body.configJson === "string") {
      try {
        JSON.parse(body.configJson);
      } catch {
        return c.json({ error: "configJson must be valid JSON" }, 400);
      }
      patch.configJson = body.configJson;
    }

    if (Object.keys(patch).length === 0) return c.json({ error: "nothing to update" }, 400);

    const updated = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new StylesRepo({ db: tx, tenantId });
      return repo.update(id, patch);
    });

    if (!updated) return c.json({ error: "style not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "style.update",
      targetKind: "style",
      targetId: id,
      details: patch,
    });

    return c.json(updated);
  });

  /**
   * DELETE /api/admin/styles/:id — soft-delete
   */
  app.delete("/api/admin/styles/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    const deleted = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new StylesRepo({ db: tx, tenantId });
      return repo.softDelete(id);
    });

    if (!deleted) return c.json({ error: "style not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "style.delete",
      targetKind: "style",
      targetId: id,
      details: {},
    });

    return c.json({ ok: true });
  });

  return app;
}
