import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { stageWebhooks } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { isBlockedIpLiteral, safeFetch, SsrfError } from "../lib/safe-fetch.ts";
import { signWebhookPayload } from "../lib/webhook-sign.ts";

/**
 * Stage-change webhooks CRUD.
 *
 * Endpoints:
 *   GET    /api/admin/stage-webhooks          — список вебхуков тенанта
 *   POST   /api/admin/stage-webhooks          — создать вебхук
 *   PATCH  /api/admin/stage-webhooks/:id      — обновить (url / secret / isActive)
 *   DELETE /api/admin/stage-webhooks/:id      — удалить
 *   POST   /api/admin/stage-webhooks/:id/test — отправить тестовый payload
 */
export function makeAdminStageWebhooksRoutes(opts: { db: Db }): Hono {
  const app = new Hono();

  app.get("/api/admin/stage-webhooks", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx.select().from(stageWebhooks).where(eq(stageWebhooks.tenantId, tenantId)),
    );
    return c.json({ items: rows.map(maskSecret) });
  });

  app.post("/api/admin/stage-webhooks", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;

    let body: { url?: unknown; secret?: unknown; isActive?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url || !isValidHttpUrl(url)) {
      return c.json({ error: "url required and must be http(s)" }, 400);
    }
    const secret =
      typeof body.secret === "string" && body.secret.trim() ? body.secret.trim() : null;
    const isActive = body.isActive !== false;
    const nowEpoch = Math.floor(Date.now() / 1000);

    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(stageWebhooks)
        .values({ tenantId, url, secret, isActive, createdAt: nowEpoch, updatedAt: nowEpoch })
        .returning(),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage_webhook.create",
      targetKind: "stage_webhook",
      targetId: row!.id,
      details: { url },
    });

    return c.json(maskSecret(row!), 201);
  });

  app.patch("/api/admin/stage-webhooks/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    let body: { url?: unknown; secret?: unknown; isActive?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const patch: Partial<{
      url: string;
      secret: string | null;
      isActive: boolean;
      updatedAt: number;
    }> = {};
    if (typeof body.url === "string") {
      const u = body.url.trim();
      if (!isValidHttpUrl(u)) return c.json({ error: "url must be http(s)" }, 400);
      patch.url = u;
    }
    if ("secret" in body) {
      patch.secret =
        typeof body.secret === "string" && body.secret.trim() ? body.secret.trim() : null;
    }
    if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
    if (Object.keys(patch).length === 0) return c.json({ error: "nothing to update" }, 400);
    patch.updatedAt = Math.floor(Date.now() / 1000);

    const [updated] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(stageWebhooks)
        .set(patch)
        .where(and(eq(stageWebhooks.id, id), eq(stageWebhooks.tenantId, tenantId)))
        .returning(),
    );
    if (!updated) return c.json({ error: "webhook not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage_webhook.update",
      targetKind: "stage_webhook",
      targetId: id,
      details: { ...patch, secret: patch.secret !== undefined ? "***" : undefined },
    });

    return c.json(maskSecret(updated));
  });

  app.delete("/api/admin/stage-webhooks/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    const [deleted] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .delete(stageWebhooks)
        .where(and(eq(stageWebhooks.id, id), eq(stageWebhooks.tenantId, tenantId)))
        .returning({ id: stageWebhooks.id }),
    );
    if (!deleted) return c.json({ error: "webhook not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage_webhook.delete",
      targetKind: "stage_webhook",
      targetId: id,
      details: {},
    });

    return c.json({ ok: true });
  });

  /**
   * POST /api/admin/stage-webhooks/:id/test
   * Sends a synthetic lead.stage_changed payload to the configured URL.
   * Returns { ok, status, body } or { ok: false, error }.
   */
  app.post("/api/admin/stage-webhooks/:id/test", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    const [hook] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(stageWebhooks)
        .where(and(eq(stageWebhooks.id, id), eq(stageWebhooks.tenantId, tenantId))),
    );
    if (!hook) return c.json({ error: "webhook not found" }, 404);

    const payload = {
      event: "lead.stage_changed",
      test: true,
      tenantId,
      leadId: 0,
      contactId: 0,
      contactName: "Test Contact",
      from: { stageId: 1, slug: "initial", displayName: "Входящий" },
      to: { stageId: 2, slug: "qualified", displayName: "Квалифицирован" },
      timestamp: Math.floor(Date.now() / 1000),
    };

    try {
      const result = await fireWebhook(hook.url, hook.secret, payload);
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}

export async function fireStageWebhooks(
  db: Db,
  tenantId: number,
  payload: StageChangedPayload,
): Promise<void> {
  const hooks = await db
    .select({ id: stageWebhooks.id, url: stageWebhooks.url, secret: stageWebhooks.secret })
    .from(stageWebhooks)
    .where(and(eq(stageWebhooks.tenantId, tenantId), eq(stageWebhooks.isActive, true)));

  if (hooks.length === 0) return;

  await Promise.allSettled(hooks.map((h) => fireWebhook(h.url, h.secret, payload)));
}

export interface StageChangedPayload {
  event: "lead.stage_changed";
  tenantId: number;
  leadId: number;
  contactId: number;
  contactName: string | null;
  from: { stageId: number | null; slug: string | null; displayName: string | null } | null;
  to: { stageId: number; slug: string; displayName: string };
  timestamp: number;
}

async function fireWebhook(
  url: string,
  secret: string | null,
  payload: object,
): Promise<{ ok: boolean; status: number; body: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "LeadEngine-Webhook/1.0",
  };
  if (secret) {
    headers["X-Signature"] = `sha256=${await signWebhookPayload(body, secret)}`;
  }

  let res: Response;
  try {
    res = await safeFetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (err instanceof SsrfError) {
      return { ok: false, status: 0, body: `blocked: ${err.message}` };
    }
    throw err;
  }
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
}

function maskSecret<T extends { secret?: string | null }>(
  row: T,
): Omit<T, "secret"> & { hasSecret: boolean } {
  const { secret, ...rest } = row;
  return { ...rest, hasSecret: Boolean(secret) };
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // Reject obvious internal targets early (literal private/loopback/link-local
    // IPs). DNS-based hosts are still re-checked at fire time by safeFetch.
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost")) return false;
    if (isBlockedIpLiteral(host)) return false;
    return true;
  } catch {
    return false;
  }
}
