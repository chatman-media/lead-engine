import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { messageTemplates } from "@chatman-media/storage";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";

/**
 * Message templates for outreach campaigns.
 *
 * GET    /api/admin/message-templates        — list
 * POST   /api/admin/message-templates        — create
 * PATCH  /api/admin/message-templates/:id    — update name/body
 * DELETE /api/admin/message-templates/:id    — delete
 */
export function makeAdminMessageTemplatesRoutes(opts: { db: Db }): Hono {
  const app = new Hono();

  app.get("/api/admin/message-templates", async (c) => {
    const tenantId = c.var.tenantId;
    const items = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(messageTemplates)
        .where(eq(messageTemplates.tenantId, tenantId))
        .orderBy(asc(messageTemplates.createdAt)),
    );
    return c.json({ items });
  });

  app.post("/api/admin/message-templates", async (c) => {
    const tenantId = c.var.tenantId;
    let body: { name?: unknown; body?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const bodyText = typeof body.body === "string" ? body.body.trim() : "";
    if (!name) return c.json({ error: "name required" }, 400);
    if (!bodyText) return c.json({ error: "body required" }, 400);

    const now = Math.floor(Date.now() / 1000);
    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(messageTemplates)
        .values({ tenantId, name, body: bodyText, createdAt: now, updatedAt: now })
        .returning(),
    );
    return c.json(row, 201);
  });

  app.patch("/api/admin/message-templates/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    let body: { name?: unknown; body?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const updates: { name?: string; body?: string; updatedAt: number } = {
      updatedAt: Math.floor(Date.now() / 1000),
    };
    let hasField = false;
    if (typeof body.name === "string" && body.name.trim()) {
      updates.name = body.name.trim();
      hasField = true;
    }
    if (typeof body.body === "string" && body.body.trim()) {
      updates.body = body.body.trim();
      hasField = true;
    }
    if (!hasField) return c.json({ error: "nothing to update" }, 400);

    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(messageTemplates)
        .set(updates)
        .where(and(eq(messageTemplates.id, id), eq(messageTemplates.tenantId, tenantId)))
        .returning(),
    );
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.delete("/api/admin/message-templates/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .delete(messageTemplates)
        .where(and(eq(messageTemplates.id, id), eq(messageTemplates.tenantId, tenantId))),
    );
    return c.json({ ok: true });
  });

  return app;
}
