import {
  type Db,
  getDecryptedSecret,
  setEncryptedSecret,
  withTenant,
} from "@chatman-media/conversation-engine";
import { tenantSecrets } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

/**
 * Per-tenant agentic tool configuration endpoints.
 *
 * Сейчас поддерживается один тип tool: "booking_link" (Calendly / Cal.com / любой URL).
 * Ссылка бронирования хранится в tenant_secrets.key = "tool_booking_url" в виде
 * plaintext (не sensitive, но хранится там ради единообразия).
 *
 * Endpoints:
 *   GET    /api/admin/tools           — список включённых tools (без secret-значений)
 *   POST   /api/admin/tools/booking   — настроить/обновить ссылку бронирования
 *   DELETE /api/admin/tools/booking   — отключить tool бронирования
 */
export interface AdminToolsRoutesOpts {
  db: Db;
  masterKeyHex: string;
  /**
   * Hot-reload hook — если задан, вызывается после POST/DELETE.
   * Используется чтобы invalidate кеш resolveTools в llm-bootstrap
   * без рестарта сервера.
   */
  onReload?: (tenantId: number) => void;
}

const BOOKING_URL_KEY = "tool_booking_url";

export function makeAdminToolsRoutes(opts: AdminToolsRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/tools
   * Returns list of configured tools for the tenant.
   * Response: { tools: Array<{ name, enabled, config }> }
   */
  app.get("/api/admin/tools", async (c) => {
    const tenantId = c.var.tenantId;

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select({ key: tenantSecrets.key })
        .from(tenantSecrets)
        .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.key, BOOKING_URL_KEY)));
    });

    const hasBookingUrl = rows.length > 0;

    return c.json({
      tools: [
        {
          name: "booking_link",
          displayName: "Ссылка бронирования (Calendly / Cal.com)",
          description:
            "Бот предлагает ссылку для записи на звонок/демо когда лид сам об этом просит.",
          enabled: hasBookingUrl,
        },
      ],
    });
  });

  /**
   * GET /api/admin/tools/booking
   * Returns the current booking URL (decrypted) for the tenant.
   */
  app.get("/api/admin/tools/booking", async (c) => {
    const tenantId = c.var.tenantId;
    const url = await getDecryptedSecret({
      db: opts.db,
      tenantId,
      key: BOOKING_URL_KEY,
      masterKeyHex: opts.masterKeyHex,
    });
    if (!url) return c.json({ enabled: false, url: null });
    return c.json({ enabled: true, url });
  });

  /**
   * POST /api/admin/tools/booking
   * Body: { url: string }
   * Validates URL format, stores in tenant_secrets.
   */
  app.post("/api/admin/tools/booking", async (c) => {
    const tenantId = c.var.tenantId;
    const body = await c.req.json().catch(() => ({}));
    const url = typeof body?.url === "string" ? body.url.trim() : "";

    if (!url) {
      return c.json({ error: "url required" }, 400);
    }

    // Basic URL validation
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return c.json({ error: "url must use http or https" }, 400);
      }
    } catch {
      return c.json({ error: "invalid url format" }, 400);
    }

    await setEncryptedSecret({
      db: opts.db,
      tenantId,
      key: BOOKING_URL_KEY,
      value: url,
      masterKeyHex: opts.masterKeyHex,
      nowEpoch: Math.floor(Date.now() / 1000),
    });

    opts.onReload?.(tenantId);

    return c.json({ ok: true, url });
  });

  /**
   * DELETE /api/admin/tools/booking
   * Removes the booking URL — disables the tool for this tenant.
   */
  app.delete("/api/admin/tools/booking", async (c) => {
    const tenantId = c.var.tenantId;

    await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .delete(tenantSecrets)
        .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.key, BOOKING_URL_KEY)));
    });

    opts.onReload?.(tenantId);

    return c.json({ ok: true });
  });

  return app;
}
