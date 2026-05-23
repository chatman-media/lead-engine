import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { directorHooks } from "@chatman-media/storage";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

/**
 * Director hooks — tenant-specific persuasion scripts.
 *
 * Endpoints:
 *   GET    /api/admin/director-hooks           — список хуков тенанта
 *   POST   /api/admin/director-hooks           — создать хук
 *   PATCH  /api/admin/director-hooks/reorder   — обновить порядок (batch)
 *   PATCH  /api/admin/director-hooks/:id       — обновить хук
 *   DELETE /api/admin/director-hooks/:id       — удалить хук
 *
 * Все роуты требуют аутентификации (requireAuth в index.ts).
 * RLS через withTenant.
 */
export interface AdminDirectorHooksRoutesOpts {
  db: Db;
}

export function makeAdminDirectorHooksRoutes(opts: AdminDirectorHooksRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/director-hooks
   * Возвращает список всех хуков тенанта, отсортированных по position.
   */
  app.get("/api/admin/director-hooks", async (c) => {
    const tenantId = c.var.tenantId;

    const items = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(directorHooks)
        .where(eq(directorHooks.tenantId, tenantId))
        .orderBy(asc(directorHooks.position), asc(directorHooks.id)),
    );

    return c.json({ items });
  });

  /**
   * POST /api/admin/director-hooks
   * Body: { name, body, triggerHint?, isActive?, position? }
   * Returns: { id, ...hook }
   */
  app.post("/api/admin/director-hooks", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;

    let payload: {
      name?: unknown;
      body?: unknown;
      triggerHint?: unknown;
      isActive?: unknown;
      position?: unknown;
    };
    try {
      payload = (await c.req.json()) as typeof payload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    if (!name) return c.json({ error: "name required" }, 400);
    if (!body) return c.json({ error: "body required" }, 400);

    const triggerHint =
      typeof payload.triggerHint === "string" && payload.triggerHint.trim().length > 0
        ? payload.triggerHint.trim()
        : null;
    const isActive = typeof payload.isActive === "boolean" ? payload.isActive : true;
    const position = typeof payload.position === "number" ? payload.position : 0;
    const nowEpoch = Math.floor(Date.now() / 1000);

    const [inserted] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(directorHooks)
        .values({
          tenantId,
          name,
          body,
          triggerHint,
          isActive,
          position,
          createdAt: nowEpoch,
          updatedAt: nowEpoch,
        })
        .returning(),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "director_hook.create",
      targetKind: "director_hook",
      targetId: inserted!.id,
      details: { name },
    });

    return c.json(inserted, 201);
  });

  /**
   * PATCH /api/admin/director-hooks/reorder
   * Body: { ids: number[] }  — полный упорядоченный список id
   * Устанавливает position = index в массиве для каждого id.
   */
  app.patch("/api/admin/director-hooks/reorder", async (c) => {
    const tenantId = c.var.tenantId;

    let payload: { ids?: unknown };
    try {
      payload = (await c.req.json()) as typeof payload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (!Array.isArray(payload.ids) || payload.ids.some((id) => typeof id !== "number")) {
      return c.json({ error: "ids must be array of numbers" }, 400);
    }

    const ids = payload.ids as number[];
    const nowEpoch = Math.floor(Date.now() / 1000);

    await withTenant(opts.db, tenantId, async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx
          .update(directorHooks)
          .set({ position: i, updatedAt: nowEpoch })
          .where(and(eq(directorHooks.id, ids[i]!), eq(directorHooks.tenantId, tenantId)));
      }
    });

    return c.json({ ok: true });
  });

  /**
   * PATCH /api/admin/director-hooks/:id
   * Body: { name?, body?, triggerHint?, isActive? }
   */
  app.patch("/api/admin/director-hooks/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    let payload: {
      name?: unknown;
      body?: unknown;
      triggerHint?: unknown;
      isActive?: unknown;
    };
    try {
      payload = (await c.req.json()) as typeof payload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const setValues: {
      updatedAt: number;
      name?: string;
      body?: string;
      triggerHint?: string | null;
      isActive?: boolean;
    } = { updatedAt: Math.floor(Date.now() / 1000) };

    if (typeof payload.name === "string" && payload.name.trim().length > 0) {
      setValues.name = payload.name.trim();
    }
    if (typeof payload.body === "string" && payload.body.trim().length > 0) {
      setValues.body = payload.body.trim();
    }
    if ("triggerHint" in payload) {
      setValues.triggerHint =
        typeof payload.triggerHint === "string" && payload.triggerHint.trim().length > 0
          ? payload.triggerHint.trim()
          : null;
    }
    if (typeof payload.isActive === "boolean") {
      setValues.isActive = payload.isActive;
    }

    const [updated] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(directorHooks)
        .set(setValues)
        .where(and(eq(directorHooks.id, id), eq(directorHooks.tenantId, tenantId)))
        .returning({ id: directorHooks.id, name: directorHooks.name }),
    );

    if (!updated) return c.json({ error: "hook not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "director_hook.update",
      targetKind: "director_hook",
      targetId: id,
      details: { name: updated.name },
    });

    return c.json({ ok: true });
  });

  /**
   * DELETE /api/admin/director-hooks/:id
   * Удаляет хук. 404 если не найден.
   */
  app.delete("/api/admin/director-hooks/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    const [deleted] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .delete(directorHooks)
        .where(and(eq(directorHooks.id, id), eq(directorHooks.tenantId, tenantId)))
        .returning({ id: directorHooks.id, name: directorHooks.name }),
    );

    if (!deleted) return c.json({ error: "hook not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "director_hook.delete",
      targetKind: "director_hook",
      targetId: id,
      details: { name: deleted.name },
    });

    return c.json({ ok: true });
  });

  return app;
}
