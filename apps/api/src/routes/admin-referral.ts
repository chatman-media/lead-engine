import { withTenant } from "@chatman-media/conversation-engine";
import { referralCodes } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";

export interface AdminReferralRoutesOpts {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  db: PostgresJsDatabase<any>;
}

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) {
    code += chars[b % chars.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function makeAdminReferralRoutes(opts: AdminReferralRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/referral-codes
   * Возвращает все реферальные коды текущего тенанта с uses_count.
   */
  app.get("/api/admin/referral-codes", async (c) => {
    const tenantId = c.var.tenantId as number;
    const rows = await withTenant(opts.db, tenantId, (tx) =>
      tx
        .select({
          id: referralCodes.id,
          code: referralCodes.code,
          usesCount: referralCodes.usesCount,
          createdAt: referralCodes.createdAt,
        })
        .from(referralCodes)
        .where(eq(referralCodes.tenantId, tenantId))
        .orderBy(referralCodes.createdAt),
    );
    return c.json({ items: rows });
  });

  /**
   * POST /api/admin/referral-codes
   * Создаёт новый реферальный код для тенанта.
   * Body: { code?: string } — если не передан, генерируется автоматически.
   */
  app.post("/api/admin/referral-codes", async (c) => {
    const tenantId = c.var.tenantId as number;
    let body: { code?: string } = {};
    try {
      body = await c.req.json<{ code?: string }>();
    } catch {
      // пустое тело — ок
    }

    const rawCode = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    const code = rawCode.length >= 3 ? rawCode : generateCode();

    if (!/^[A-Z0-9][A-Z0-9-]{1,18}[A-Z0-9]$/i.test(code)) {
      return c.json({ error: "invalid code format (3-20 chars, A-Z0-9 and -)" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    let row: typeof referralCodes.$inferSelect;
    try {
      const [inserted] = await withTenant(opts.db, tenantId, (tx) =>
        tx
          .insert(referralCodes)
          .values({ tenantId, code, usesCount: 0, createdAt: now })
          .returning(),
      );
      row = inserted!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique") || msg.includes("duplicate")) {
        return c.json({ error: "code already exists" }, 409);
      }
      throw err;
    }

    return c.json({ item: { id: row.id, code: row.code, usesCount: row.usesCount, createdAt: row.createdAt } }, 201);
  });

  /**
   * DELETE /api/admin/referral-codes/:id
   */
  app.delete("/api/admin/referral-codes/:id", async (c) => {
    const tenantId = c.var.tenantId as number;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    await withTenant(opts.db, tenantId, (tx) =>
      tx
        .delete(referralCodes)
        .where(and(eq(referralCodes.id, id), eq(referralCodes.tenantId, tenantId))),
    );

    return c.json({ ok: true });
  });

  return app;
}
