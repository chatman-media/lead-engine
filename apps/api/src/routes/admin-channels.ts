import { TelegramApiError, TelegramClient } from "@chatman-media/channel-telegram";
import {
  type Db,
  setEncryptedSecret,
  withTenant,
} from "@chatman-media/conversation-engine";
import { channels } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

/**
 * Per-tenant channel CRUD под /api/admin/channels/*.
 *
 * Schema (channels):
 *   (tenant_id, kind, external_id, credentials_ref, status, metadata_json)
 *
 * MVP scope: только `telegram_bot`. Userbot / WhatsApp / web — отдельные
 * onboarding-flow'ы (MTProto QR-pairing, Meta OAuth, embed-snippet).
 *
 * Endpoints:
 *   GET    /api/admin/channels            — list (WITHOUT credentials)
 *   POST   /api/admin/channels/telegram   — create from bot token
 *   DELETE /api/admin/channels/:id        — drop (token остаётся в tenant_secrets)
 *
 * POST flow:
 *   1. Validate token через TelegramClient.getMe() — bot username + id.
 *   2. Encrypt token в tenant_secrets под key=`channel_telegram_bot_<username>`.
 *   3. Insert channels row с credentials_ref на этот key.
 *
 * NB: Channels подхватываются ChannelRegistry только при boot apps/api +
 * apps/worker. После POST нужен restart обоих процессов (CD-deploy hooks
 * — TODO).
 */
export interface AdminChannelsRoutesOpts {
  db: Db;
  masterKeyHex: string;
  /** Custom fetch для тестов — позволяет stub'нуть Telegram getMe. */
  fetchImpl?: typeof fetch;
}

interface TelegramCreateBody {
  botToken: unknown;
}

export function makeAdminChannelsRoutes(opts: AdminChannelsRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/channels — list per-tenant. Returns:
   *   { items: [{ id, kind, externalId, status, hasCredentials, createdAt }] }
   * credentials_ref value НЕ возвращается (только bool флаг что secret есть).
   */
  app.get("/api/admin/channels", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select({
          id: channels.id,
          kind: channels.kind,
          externalId: channels.externalId,
          credentialsRef: channels.credentialsRef,
          status: channels.status,
          createdAt: channels.createdAt,
          updatedAt: channels.updatedAt,
        })
        .from(channels)
        .where(eq(channels.tenantId, tenantId));
    });
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        externalId: r.externalId,
        status: r.status,
        hasCredentials: r.credentialsRef !== null && r.credentialsRef !== "",
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  /**
   * POST /api/admin/channels/telegram
   * Body: { botToken: string }
   *
   * 1. Validate via Telegram getMe — bot username derived.
   * 2. Encrypt token в tenant_secrets.
   * 3. Insert channels row (kind=telegram_bot, external_id=username).
   *
   * Errors:
   *   400 — botToken missing / not string
   *   401 — Telegram отверг token (invalid)
   *   409 — bot already registered для этого tenant'а (uniq constraint
   *         (tenant_id, kind, external_id))
   *   502 — Telegram unreachable
   */
  app.post("/api/admin/channels/telegram", async (c) => {
    const tenantId = c.var.tenantId;
    let body: TelegramCreateBody;
    try {
      body = (await c.req.json()) as TelegramCreateBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
    if (!botToken) {
      return c.json({ error: "botToken required" }, 400);
    }
    // Basic format check: Telegram bot tokens look like `<digits>:<token>`.
    if (!/^\d+:[\w-]{30,}$/.test(botToken)) {
      return c.json({ error: "botToken does not match Telegram format" }, 400);
    }

    // Validate via getMe.
    const tgClient = new TelegramClient({
      token: botToken,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    let username: string;
    let botId: number;
    try {
      const me = await tgClient.getMe();
      if (!me.is_bot || !me.username) {
        return c.json({ error: "token does not belong to a bot" }, 400);
      }
      username = me.username;
      botId = me.id;
    } catch (err) {
      if (err instanceof TelegramApiError) {
        // 401 — invalid token. 404 — Telegram возвращает на bad token тоже.
        if (err.statusCode === 401 || err.statusCode === 404) {
          return c.json({ error: "Telegram rejected token (invalid)" }, 401);
        }
      }
      return c.json(
        {
          error: "Telegram unreachable or rejected",
          detail: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const secretKey = `channel_telegram_bot_${username}`;

    try {
      const result = await withTenant(opts.db, tenantId, async (tx) => {
        // Existing channel by uniq (tenant_id, kind, external_id)?
        const [existing] = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.tenantId, tenantId),
              eq(channels.kind, "telegram_bot"),
              eq(channels.externalId, username),
            ),
          );
        if (existing) {
          // Re-encrypt token under same secret key (rotation). Bump updatedAt.
          await setEncryptedSecret({
            db: tx,
            tenantId,
            key: secretKey,
            value: botToken,
            masterKeyHex: opts.masterKeyHex,
            nowEpoch,
          });
          await tx
            .update(channels)
            .set({
              credentialsRef: secretKey,
              status: "active",
              metadataJson: JSON.stringify({ bot_id: botId }),
              updatedAt: nowEpoch,
            })
            .where(eq(channels.id, existing.id));
          return { id: existing.id, updated: true };
        }
        await setEncryptedSecret({
          db: tx,
          tenantId,
          key: secretKey,
          value: botToken,
          masterKeyHex: opts.masterKeyHex,
          nowEpoch,
        });
        const [inserted] = await tx
          .insert(channels)
          .values({
            tenantId,
            kind: "telegram_bot",
            externalId: username,
            credentialsRef: secretKey,
            status: "active",
            metadataJson: JSON.stringify({ bot_id: botId }),
            createdAt: nowEpoch,
            updatedAt: nowEpoch,
          })
          .returning({ id: channels.id });
        return { id: inserted!.id, updated: false };
      });
      return c.json({ ok: true, ...result, username, botId });
    } catch (err) {
      // Unique-violation guard на случай race.
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        return c.json({ error: "channel already exists", username }, 409);
      }
      throw err;
    }
  });

  /**
   * DELETE /api/admin/channels/:id
   * Drops the channel row. tenant_secrets с токеном остаётся (manual cleanup
   * для безопасности — admin может вернуть бота не теряя сохранённый token).
   */
  app.delete("/api/admin/channels/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const idStr = c.req.param("id");
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: "invalid id" }, 400);
    }
    const deleted = await withTenant(opts.db, tenantId, async (tx) => {
      const result = await tx
        .delete(channels)
        .where(and(eq(channels.tenantId, tenantId), eq(channels.id, id)))
        .returning({ id: channels.id });
      return result.length;
    });
    if (deleted === 0) return c.json({ error: "channel not found" }, 404);
    return c.json({ ok: true, deleted });
  });

  return app;
}
