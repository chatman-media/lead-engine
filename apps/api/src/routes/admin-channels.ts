import { randomUUID } from "node:crypto";
import { MessengerApiError, MessengerClient } from "@chatman-media/channel-facebook";
import {
  type FinishedUserbotLogin,
  startUserbotLogin,
  submitUserbot2fa,
  submitUserbotCode,
  TelegramApiError,
  TelegramClient,
  UserbotLoginError,
} from "@chatman-media/channel-telegram";
import { VkApiError, VkClient } from "@chatman-media/channel-vk";
import { WhatsAppApiError, WhatsAppClient } from "@chatman-media/channel-whatsapp";
import { type Db, setEncryptedSecret, withTenant } from "@chatman-media/conversation-engine";
import { channels, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import {
  FACEBOOK_APP_SECRET_KEY,
  FACEBOOK_VERIFY_TOKEN_KEY,
  VK_CONFIRMATION_CODE_KEY,
  VK_SECRET_KEY,
  WHATSAPP_APP_SECRET_KEY,
  WHATSAPP_VERIFY_TOKEN_KEY,
} from "../channel-registry.ts";
import { recordAudit } from "../lib/audit.ts";
import { canAddChannel } from "../lib/quota.ts";
import { resolveUserbotCreds, setUserbotCreds } from "../lib/userbot-creds.ts";
import type { UserbotLoginStore } from "../lib/userbot-login-store.ts";

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
 * NB: apps/api hot-reload'ит ChannelRegistry через onReload callback
 * (TenantReloader.reloadChannels) — без рестарта. apps/worker требует
 * рестарта для подхвата новых каналов (cross-process pub/sub — Phase 2).
 */
export interface AdminChannelsRoutesOpts {
  db: Db;
  masterKeyHex: string;
  /** Custom fetch для тестов — позволяет stub'нуть Telegram getMe + setWebhook. */
  fetchImpl?: typeof fetch;
  /**
   * External-facing URL apps/api (e.g. "https://api.leadengine.app").
   * Если задан — POST /telegram автоматически setWebhook'ает Telegram на
   * `<publicUrl>/webhook/telegram/<tenant.slug>`. Если пусто — admin
   * настраивает webhook вручную.
   */
  publicUrl?: string;
  /**
   * Secret-token для X-Telegram-Bot-Api-Secret-Token (см. cfg.telegramWebhookSecret).
   * Передаётся в setWebhook чтобы наш webhook handler фильтровал spoofed POST'ы.
   * Если publicUrl задан — этот тоже обязан быть.
   */
  webhookSecret?: string;
  /**
   * Hot-reload hook — вызывается после успешного POST/DELETE с tenantId.
   * Перестраивает ChannelRegistry entries для этого tenant'а в текущем
   * процессе. apps/worker — отдельный процесс, ему нужен restart.
   */
  onReload?: (tenantId: number) => Promise<void>;
  /**
   * WhatsApp Meta verify_token — нужен для webhookSetupHint в POST /whatsapp
   * response (UI показывает copy-paste snippet для Meta dashboard webhook
   * configuration).
   */
  whatsappVerifyToken?: string;
  /**
   * Facebook Meta verify_token — нужен для webhookSetupHint в POST /facebook
   * response (UI показывает copy-paste snippet для Meta dashboard webhook
   * configuration).
   */
  facebookVerifyToken?: string;
  /**
   * VK Callback API fallback confirmation code/secret. Prefer per-tenant values
   * posted via /api/admin/channels/vk; env fallback is for legacy/dev.
   */
  vkConfirmationCode?: string;
  vkSecretKey?: string;
  /**
   * URL CDN-bundle'а виджета. Если задан — POST /web возвращает
   * production-ready `<script src="...">` snippet. Если пусто (текущее
   * состояние M3a — bundle ещё не задеплоен) — fallback на demo HTML
   * link для smoke-теста.
   */
  webWidgetScriptUrl?: string;
  /**
   * Telegram MTProto app credentials (платформенные, из env). Нужны для
   * onboarding'а personal-account userbot'ов. Если apiId=0 / apiHash пуст /
   * userbotLoginStore не передан — userbot-роуты возвращают 503.
   */
  telegramApiId?: number;
  telegramApiHash?: string;
  /** In-memory стор незавершённых userbot-логинов (см. userbot-login-store.ts). */
  userbotLoginStore?: UserbotLoginStore;
}

function generateWebWidgetSnippet(opts: {
  publicUrl: string;
  tenantSlug: string;
  externalId: string;
  webWidgetScriptUrl: string | undefined;
  brandName: string | undefined;
  primaryColor: string | undefined;
  authSecret: string | undefined;
}): { html: string; wsUrl: string; demoUrl: string } {
  const wsBase = opts.publicUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  const wsUrl = `${wsBase}/ws/${opts.externalId}`;
  const demoUrl = `${opts.publicUrl}/demo/web-chat.html?host=${encodeURIComponent(
    opts.publicUrl,
  )}&slug=${encodeURIComponent(opts.externalId)}`;

  const dataAttrs = [
    `data-slug="${opts.externalId}"`,
    `data-host="${opts.publicUrl}"`,
    opts.brandName ? `data-brand="${escapeHtmlAttr(opts.brandName)}"` : "",
    opts.primaryColor ? `data-color="${escapeHtmlAttr(opts.primaryColor)}"` : "",
    opts.authSecret ? `data-auth="REPLACE_WITH_USER_JWT"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const scriptSrc = opts.webWidgetScriptUrl
    ? opts.webWidgetScriptUrl
    : `${opts.publicUrl}/widget.js`; // fallback: /widget.js served from same origin

  const html = [
    "<!-- lead-engine chat widget — вставить перед </body> -->",
    `<script async src="${scriptSrc}" ${dataAttrs}></script>`,
  ].join("\n");

  return { html, wsUrl, demoUrl };
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Достаёт `username` из metadata_json канала (для UI), null если нет/невалидно. */
function parseChannelUsername(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const meta = JSON.parse(metadataJson) as { username?: unknown };
    return typeof meta.username === "string" ? meta.username : null;
  } catch {
    return null;
  }
}

interface TelegramCreateBody {
  botToken: unknown;
}

interface WhatsAppCreateBody {
  phoneNumberId: unknown;
  accessToken: unknown;
  businessAccountId?: unknown;
  /** Per-tenant Meta webhook verify_token (опц.) — фолбэк на env WHATSAPP_VERIFY_TOKEN. */
  verifyToken?: unknown;
  /** Per-tenant Meta app secret (опц.) — фолбэк на env WHATSAPP_APP_SECRET. */
  appSecret?: unknown;
}

interface FacebookCreateBody {
  /** Page Access Token (long-lived). Page id выводится из него через Graph. */
  pageAccessToken: unknown;
  /** Per-tenant Meta webhook verify_token (опц.) — фолбэк на env FACEBOOK_VERIFY_TOKEN. */
  verifyToken?: unknown;
  /** Per-tenant Meta app secret (опц.) — фолбэк на env FACEBOOK_APP_SECRET. */
  appSecret?: unknown;
}

interface VkCreateBody {
  /** Numeric community/group id. */
  groupId: unknown;
  /** Community access token with messages permission. */
  accessToken: unknown;
  /** Callback API confirmation code for this community. */
  confirmationCode?: unknown;
  /** Optional Callback API secret key, checked against payload.secret. */
  secretKey?: unknown;
}

interface WebCreateBody {
  /** Optional override external_id (по умолчанию tenant.slug). */
  externalId?: unknown;
  /** Optional branding для widget snippet (UI кастомизация). */
  brandName?: unknown;
  primaryColor?: unknown;
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
          metadataJson: channels.metadataJson,
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
        // username для userbot/telegram — для дружелюбного отображения в UI.
        username: parseChannelUsername(r.metadataJson),
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

    // Quota check: только для new-channel path. Token rotation для
    // existing channel (тот же username) не считается against quota.
    const [maybeExisting] = await opts.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.tenantId, tenantId),
          eq(channels.kind, "telegram_bot"),
          eq(channels.externalId, username),
        ),
      );
    if (!maybeExisting) {
      const quota = await canAddChannel({ db: opts.db, tenantId });
      if (!quota.allowed) {
        return c.json(
          {
            error: "quota_exceeded",
            reason: quota.reason,
            limit: quota.limit,
            current: quota.current,
            plan: quota.plan,
            planLabel: quota.planLabel,
            upgradeHint: "Перейдите на план Starter ($99/мес) для большего числа каналов",
          },
          402,
        );
      }
    }

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
      // Auto-setWebhook: после успешного create вызываем Telegram setWebhook
      // чтобы канал заработал без manual configure. Если webhook setup fails —
      // НЕ откатываем channel (он валиден, можно retry'нуть позже).
      let webhookSet = false;
      let webhookError: string | undefined;
      if (opts.publicUrl && opts.webhookSecret) {
        try {
          // Резолвим tenant slug для URL.
          const [tenant] = await opts.db
            .select({ slug: tenants.slug })
            .from(tenants)
            .where(eq(tenants.id, tenantId));
          if (tenant) {
            const webhookUrl = `${opts.publicUrl}/webhook/telegram/${tenant.slug}`;
            await tgClient.setWebhook({
              url: webhookUrl,
              secretToken: opts.webhookSecret,
              allowedUpdates: ["message", "callback_query", "edited_message"],
            });
            webhookSet = true;
          }
        } catch (err) {
          webhookError = err instanceof Error ? err.message : String(err);
        }
      }

      await recordAudit(opts.db, {
        tenantId,
        adminId: c.var.adminId,
        action: result.updated ? "channel.update" : "channel.create",
        targetKind: "channel",
        targetId: result.id,
        details: {
          kind: "telegram_bot",
          username,
          botId,
          webhookSet,
        },
      });

      let reloadError: string | undefined;
      if (opts.onReload) {
        try {
          await opts.onReload(tenantId);
        } catch (err) {
          reloadError = err instanceof Error ? err.message : String(err);
        }
      }

      return c.json({
        ok: true,
        ...result,
        username,
        botId,
        webhookSet,
        ...(webhookError ? { webhookError } : {}),
        ...(reloadError ? { reloadError } : {}),
      });
    } catch (err) {
      // Unique-violation guard на случай race.
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        return c.json({ error: "channel already exists", username }, 409);
      }
      throw err;
    }
  });

  /**
   * POST /api/admin/channels/whatsapp
   * Body: { phoneNumberId, accessToken, businessAccountId? }
   *
   * 1. Validate via Meta Graph `GET /<phone_number_id>` — Bearer token.
   * 2. Encrypt token в tenant_secrets[channel_whatsapp_<phoneNumberId>].
   * 3. Insert channels row (kind=whatsapp, external_id=phoneNumberId).
   *
   * Meta webhook setup НЕ авто-настраивается (Meta dashboard ручной).
   * Response содержит `webhookSetupHint` с URL + verify_token для UI
   * copy-paste-инструкции.
   *
   * Errors:
   *   400 — bad json / required fields missing
   *   401 — Meta отверг token (Bearer auth failed) или phoneNumberId
   *         не принадлежит этому token
   *   404 — phoneNumberId не существует
   *   502 — Meta unreachable
   */
  app.post("/api/admin/channels/whatsapp", async (c) => {
    const tenantId = c.var.tenantId;
    let body: WhatsAppCreateBody;
    try {
      body = (await c.req.json()) as WhatsAppCreateBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const phoneNumberId = typeof body.phoneNumberId === "string" ? body.phoneNumberId.trim() : "";
    const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    if (!phoneNumberId) {
      return c.json({ error: "phoneNumberId required" }, 400);
    }
    if (!accessToken) {
      return c.json({ error: "accessToken required" }, 400);
    }
    if (!/^\d{10,20}$/.test(phoneNumberId)) {
      return c.json({ error: "phoneNumberId must be Meta numeric ID (10-20 digits)" }, 400);
    }
    const businessAccountId =
      typeof body.businessAccountId === "string" && body.businessAccountId.trim()
        ? body.businessAccountId.trim()
        : null;
    const verifyToken = typeof body.verifyToken === "string" ? body.verifyToken.trim() : "";
    const appSecret = typeof body.appSecret === "string" ? body.appSecret.trim() : "";

    // Validate via Meta Graph.
    const waClient = new WhatsAppClient({
      phoneNumberId,
      accessToken,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    let phoneInfo: Awaited<ReturnType<WhatsAppClient["getPhoneInfo"]>>;
    try {
      phoneInfo = await waClient.getPhoneInfo();
    } catch (err) {
      if (err instanceof WhatsAppApiError) {
        if (err.statusCode === 401 || err.statusCode === 403) {
          return c.json({ error: "Meta rejected token (invalid)" }, 401);
        }
        if (err.statusCode === 404) {
          return c.json({ error: "phoneNumberId not found" }, 404);
        }
      }
      return c.json(
        {
          error: "Meta Graph unreachable or rejected",
          detail: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const secretKey = `channel_whatsapp_${phoneNumberId}`;

    // Quota check для new WhatsApp channel (см. telegram POST).
    const [maybeExistingWa] = await opts.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.tenantId, tenantId),
          eq(channels.kind, "whatsapp"),
          eq(channels.externalId, phoneNumberId),
        ),
      );
    if (!maybeExistingWa) {
      const quota = await canAddChannel({ db: opts.db, tenantId });
      if (!quota.allowed) {
        return c.json(
          {
            error: "quota_exceeded",
            reason: quota.reason,
            limit: quota.limit,
            current: quota.current,
            plan: quota.plan,
            planLabel: quota.planLabel,
            upgradeHint: "Перейдите на план Starter ($99/мес) для большего числа каналов",
          },
          402,
        );
      }
    }

    try {
      const result = await withTenant(opts.db, tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.tenantId, tenantId),
              eq(channels.kind, "whatsapp"),
              eq(channels.externalId, phoneNumberId),
            ),
          );

        const metadata = JSON.stringify({
          verifiedName: phoneInfo.verifiedName,
          displayPhoneNumber: phoneInfo.displayPhoneNumber,
          qualityRating: phoneInfo.qualityRating,
          ...(businessAccountId ? { businessAccountId } : {}),
        });

        // Per-tenant Meta webhook creds (опц.) — шифруем в tenant_secrets, чтобы
        // ChannelRegistry резолвил их в entry, а webhook валидировал без env.
        if (verifyToken) {
          await setEncryptedSecret({
            db: tx,
            tenantId,
            key: WHATSAPP_VERIFY_TOKEN_KEY,
            value: verifyToken,
            masterKeyHex: opts.masterKeyHex,
            nowEpoch,
          });
        }
        if (appSecret) {
          await setEncryptedSecret({
            db: tx,
            tenantId,
            key: WHATSAPP_APP_SECRET_KEY,
            value: appSecret,
            masterKeyHex: opts.masterKeyHex,
            nowEpoch,
          });
        }

        if (existing) {
          await setEncryptedSecret({
            db: tx,
            tenantId,
            key: secretKey,
            value: accessToken,
            masterKeyHex: opts.masterKeyHex,
            nowEpoch,
          });
          await tx
            .update(channels)
            .set({
              credentialsRef: secretKey,
              status: "active",
              metadataJson: metadata,
              updatedAt: nowEpoch,
            })
            .where(eq(channels.id, existing.id));
          return { id: existing.id, updated: true };
        }
        await setEncryptedSecret({
          db: tx,
          tenantId,
          key: secretKey,
          value: accessToken,
          masterKeyHex: opts.masterKeyHex,
          nowEpoch,
        });
        const [inserted] = await tx
          .insert(channels)
          .values({
            tenantId,
            kind: "whatsapp",
            externalId: phoneNumberId,
            credentialsRef: secretKey,
            status: "active",
            metadataJson: metadata,
            createdAt: nowEpoch,
            updatedAt: nowEpoch,
          })
          .returning({ id: channels.id });
        return { id: inserted!.id, updated: false };
      });

      await recordAudit(opts.db, {
        tenantId,
        adminId: c.var.adminId,
        action: result.updated ? "channel.update" : "channel.create",
        targetKind: "channel",
        targetId: result.id,
        details: {
          kind: "whatsapp",
          phoneNumberId,
          verifiedName: phoneInfo.verifiedName,
          displayPhoneNumber: phoneInfo.displayPhoneNumber,
        },
      });

      let reloadError: string | undefined;
      if (opts.onReload) {
        try {
          await opts.onReload(tenantId);
        } catch (err) {
          reloadError = err instanceof Error ? err.message : String(err);
        }
      }

      // Resolve tenant slug для webhookSetupHint.
      let webhookSetupHint: { url: string; verifyToken: string; appSecretHint: string } | undefined;
      if (opts.publicUrl) {
        const [tenant] = await opts.db
          .select({ slug: tenants.slug })
          .from(tenants)
          .where(eq(tenants.id, tenantId));
        if (tenant) {
          webhookSetupHint = {
            url: `${opts.publicUrl}/webhook/whatsapp/${tenant.slug}`,
            verifyToken: verifyToken || opts.whatsappVerifyToken || "<укажите Verify Token>",
            appSecretHint: appSecret
              ? "App Secret сохранён — подпись вебхуков будет проверяться"
              : "Meta dashboard → App settings → Basic → App Secret (укажите в форме или в env WHATSAPP_APP_SECRET)",
          };
        }
      }

      return c.json({
        ok: true,
        ...result,
        phoneNumberId,
        verifiedName: phoneInfo.verifiedName,
        displayPhoneNumber: phoneInfo.displayPhoneNumber,
        ...(webhookSetupHint ? { webhookSetupHint } : {}),
        ...(reloadError ? { reloadError } : {}),
      });
    } catch (err) {
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        return c.json({ error: "channel already exists", phoneNumberId }, 409);
      }
      throw err;
    }
  });

  /**
   * POST /api/admin/channels/facebook
   * Body: { pageAccessToken, verifyToken?, appSecret? }
   *
   * Page Access Token однозначно принадлежит одной Facebook Page, поэтому
   * page id выводим из Graph (/me), не требуем в body. Зеркалит /whatsapp:
   * validate → encrypt в tenant_secrets (channel_facebook_<pageId>) → upsert
   * channels(kind='facebook', external_id=pageId).
   *
   * Errors: 400 bad json / token missing · 401 Meta отверг token · 502 Meta down
   */
  app.post("/api/admin/channels/facebook", async (c) => {
    const tenantId = c.var.tenantId;
    let body: FacebookCreateBody;
    try {
      body = (await c.req.json()) as FacebookCreateBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const pageAccessToken =
      typeof body.pageAccessToken === "string" ? body.pageAccessToken.trim() : "";
    if (!pageAccessToken) {
      return c.json({ error: "pageAccessToken required" }, 400);
    }
    const verifyToken = typeof body.verifyToken === "string" ? body.verifyToken.trim() : "";
    const appSecret = typeof body.appSecret === "string" ? body.appSecret.trim() : "";

    // Validate token via Meta Graph (/me) → page id + name.
    const fbClient = new MessengerClient({
      pageAccessToken,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    let pageInfo: Awaited<ReturnType<MessengerClient["getPageInfo"]>>;
    try {
      pageInfo = await fbClient.getPageInfo();
    } catch (err) {
      if (err instanceof MessengerApiError && (err.statusCode === 401 || err.statusCode === 403)) {
        return c.json({ error: "Meta rejected token (invalid)" }, 401);
      }
      return c.json(
        {
          error: "Meta Graph unreachable or rejected",
          detail: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
    const pageId = pageInfo.id;
    if (!/^\d{5,25}$/.test(pageId)) {
      return c.json({ error: "Meta returned unexpected page id" }, 502);
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const secretKey = `channel_facebook_${pageId}`;

    // Quota check для new Facebook channel (см. telegram/whatsapp POST).
    const [maybeExistingFb] = await opts.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.tenantId, tenantId),
          eq(channels.kind, "facebook"),
          eq(channels.externalId, pageId),
        ),
      );
    if (!maybeExistingFb) {
      const quota = await canAddChannel({ db: opts.db, tenantId });
      if (!quota.allowed) {
        return c.json(
          {
            error: "quota_exceeded",
            reason: quota.reason,
            limit: quota.limit,
            current: quota.current,
            plan: quota.plan,
            planLabel: quota.planLabel,
            upgradeHint: "Перейдите на план Starter ($99/мес) для большего числа каналов",
          },
          402,
        );
      }
    }

    try {
      const result = await withTenant(opts.db, tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.tenantId, tenantId),
              eq(channels.kind, "facebook"),
              eq(channels.externalId, pageId),
            ),
          );

        const metadata = JSON.stringify({ pageName: pageInfo.name ?? null });

        // Per-tenant Meta webhook creds (опц.) — шифруем в tenant_secrets.
        if (verifyToken) {
          await setEncryptedSecret({
            db: tx,
            tenantId,
            key: FACEBOOK_VERIFY_TOKEN_KEY,
            value: verifyToken,
            masterKeyHex: opts.masterKeyHex,
            nowEpoch,
          });
        }
        if (appSecret) {
          await setEncryptedSecret({
            db: tx,
            tenantId,
            key: FACEBOOK_APP_SECRET_KEY,
            value: appSecret,
            masterKeyHex: opts.masterKeyHex,
            nowEpoch,
          });
        }
        await setEncryptedSecret({
          db: tx,
          tenantId,
          key: secretKey,
          value: pageAccessToken,
          masterKeyHex: opts.masterKeyHex,
          nowEpoch,
        });

        if (existing) {
          await tx
            .update(channels)
            .set({
              credentialsRef: secretKey,
              status: "active",
              metadataJson: metadata,
              updatedAt: nowEpoch,
            })
            .where(eq(channels.id, existing.id));
          return { id: existing.id, updated: true };
        }
        const [inserted] = await tx
          .insert(channels)
          .values({
            tenantId,
            kind: "facebook",
            externalId: pageId,
            credentialsRef: secretKey,
            status: "active",
            metadataJson: metadata,
            createdAt: nowEpoch,
            updatedAt: nowEpoch,
          })
          .returning({ id: channels.id });
        return { id: inserted!.id, updated: false };
      });

      await recordAudit(opts.db, {
        tenantId,
        adminId: c.var.adminId,
        action: result.updated ? "channel.update" : "channel.create",
        targetKind: "channel",
        targetId: result.id,
        details: { kind: "facebook", pageId, pageName: pageInfo.name },
      });

      let reloadError: string | undefined;
      if (opts.onReload) {
        try {
          await opts.onReload(tenantId);
        } catch (err) {
          reloadError = err instanceof Error ? err.message : String(err);
        }
      }

      let webhookSetupHint: { url: string; verifyToken: string; appSecretHint: string } | undefined;
      if (opts.publicUrl) {
        const [tenant] = await opts.db
          .select({ slug: tenants.slug })
          .from(tenants)
          .where(eq(tenants.id, tenantId));
        if (tenant) {
          webhookSetupHint = {
            url: `${opts.publicUrl}/webhook/facebook/${tenant.slug}`,
            verifyToken: verifyToken || opts.facebookVerifyToken || "<укажите Verify Token>",
            appSecretHint: appSecret
              ? "App Secret сохранён — подпись вебхуков будет проверяться"
              : "Meta dashboard → App settings → Basic → App Secret (укажите в форме или в env FACEBOOK_APP_SECRET)",
          };
        }
      }

      return c.json({
        ok: true,
        ...result,
        pageId,
        ...(pageInfo.name ? { pageName: pageInfo.name } : {}),
        ...(webhookSetupHint ? { webhookSetupHint } : {}),
        ...(reloadError ? { reloadError } : {}),
      });
    } catch (err) {
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        return c.json({ error: "channel already exists", pageId }, 409);
      }
      throw err;
    }
  });

  /**
   * POST /api/admin/channels/vk
   * Body: { groupId, accessToken, confirmationCode?, secretKey? }
   *
   * VK community channel via Callback API. Mirrors the Meta webhook channels:
   * validate token/group → encrypt tenant secrets → upsert channels(kind='vk')
   * → return webhookSetupHint for VK community settings.
   */
  app.post("/api/admin/channels/vk", async (c) => {
    const tenantId = c.var.tenantId;
    let body: VkCreateBody;
    try {
      body = (await c.req.json()) as VkCreateBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const groupId =
      typeof body.groupId === "string"
        ? body.groupId.trim()
        : typeof body.groupId === "number" && Number.isFinite(body.groupId)
          ? String(Math.trunc(body.groupId))
          : "";
    const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    const confirmationCode =
      typeof body.confirmationCode === "string" && body.confirmationCode.trim()
        ? body.confirmationCode.trim()
        : (opts.vkConfirmationCode ?? "");
    const secretKey =
      typeof body.secretKey === "string" && body.secretKey.trim()
        ? body.secretKey.trim()
        : (opts.vkSecretKey ?? "");

    if (!groupId) return c.json({ error: "groupId required" }, 400);
    if (!/^\d{1,20}$/.test(groupId)) {
      return c.json({ error: "groupId must be numeric VK community id" }, 400);
    }
    if (!accessToken) return c.json({ error: "accessToken required" }, 400);
    if (!confirmationCode) {
      return c.json({ error: "confirmationCode required" }, 400);
    }

    const vkClient = new VkClient({
      accessToken,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    let groupInfo: Awaited<ReturnType<VkClient["getGroupInfo"]>>;
    try {
      groupInfo = await vkClient.getGroupInfo(groupId);
    } catch (err) {
      if (err instanceof VkApiError) {
        if (err.code === 5 || err.code === 15 || err.statusCode === 401 || err.statusCode === 403) {
          return c.json({ error: "VK rejected token (invalid or insufficient permissions)" }, 401);
        }
        if (err.code === 100 || /not found/i.test(err.description)) {
          return c.json({ error: "groupId not found" }, 404);
        }
      }
      return c.json(
        {
          error: "VK API unreachable or rejected",
          detail: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
    if (String(groupInfo.id) !== groupId) {
      return c.json({ error: "VK returned unexpected group id" }, 502);
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const secretRef = `channel_vk_${groupId}`;

    const [maybeExistingVk] = await opts.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.tenantId, tenantId),
          eq(channels.kind, "vk"),
          eq(channels.externalId, groupId),
        ),
      );
    if (!maybeExistingVk) {
      const quota = await canAddChannel({ db: opts.db, tenantId });
      if (!quota.allowed) {
        return c.json(
          {
            error: "quota_exceeded",
            reason: quota.reason,
            limit: quota.limit,
            current: quota.current,
            plan: quota.plan,
            planLabel: quota.planLabel,
            upgradeHint: "Перейдите на план Starter ($99/мес) для большего числа каналов",
          },
          402,
        );
      }
    }

    try {
      const result = await withTenant(opts.db, tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.tenantId, tenantId),
              eq(channels.kind, "vk"),
              eq(channels.externalId, groupId),
            ),
          );

        await setEncryptedSecret({
          db: tx,
          tenantId,
          key: secretRef,
          value: accessToken,
          masterKeyHex: opts.masterKeyHex,
          nowEpoch,
        });
        await setEncryptedSecret({
          db: tx,
          tenantId,
          key: VK_CONFIRMATION_CODE_KEY,
          value: confirmationCode,
          masterKeyHex: opts.masterKeyHex,
          nowEpoch,
        });
        if (secretKey) {
          await setEncryptedSecret({
            db: tx,
            tenantId,
            key: VK_SECRET_KEY,
            value: secretKey,
            masterKeyHex: opts.masterKeyHex,
            nowEpoch,
          });
        }

        const metadata = JSON.stringify({
          ...(groupInfo.name ? { groupName: groupInfo.name } : {}),
          ...(groupInfo.screenName ? { screenName: groupInfo.screenName } : {}),
        });
        if (existing) {
          await tx
            .update(channels)
            .set({
              credentialsRef: secretRef,
              status: "active",
              metadataJson: metadata,
              updatedAt: nowEpoch,
            })
            .where(eq(channels.id, existing.id));
          return { id: existing.id, updated: true };
        }
        const [inserted] = await tx
          .insert(channels)
          .values({
            tenantId,
            kind: "vk",
            externalId: groupId,
            credentialsRef: secretRef,
            status: "active",
            metadataJson: metadata,
            createdAt: nowEpoch,
            updatedAt: nowEpoch,
          })
          .returning({ id: channels.id });
        return { id: inserted!.id, updated: false };
      });

      await recordAudit(opts.db, {
        tenantId,
        adminId: c.var.adminId,
        action: result.updated ? "channel.update" : "channel.create",
        targetKind: "channel",
        targetId: result.id,
        details: { kind: "vk", groupId, groupName: groupInfo.name ?? null },
      });

      let reloadError: string | undefined;
      if (opts.onReload) {
        try {
          await opts.onReload(tenantId);
        } catch (err) {
          reloadError = err instanceof Error ? err.message : String(err);
        }
      }

      let webhookSetupHint:
        | { url: string; confirmationCode: string; secretKeyHint: string; eventTypes: string[] }
        | undefined;
      if (opts.publicUrl) {
        const [tenant] = await opts.db
          .select({ slug: tenants.slug })
          .from(tenants)
          .where(eq(tenants.id, tenantId));
        if (tenant) {
          webhookSetupHint = {
            url: `${opts.publicUrl}/webhook/vk/${tenant.slug}`,
            confirmationCode,
            secretKeyHint: secretKey
              ? "Secret key сохранён — payload.secret будет проверяться"
              : "VK community → Callback API → Secret key (укажите в форме или env VK_SECRET_KEY)",
            eventTypes: ["message_new"],
          };
        }
      }

      return c.json({
        ok: true,
        ...result,
        groupId,
        ...(groupInfo.name ? { groupName: groupInfo.name } : {}),
        ...(groupInfo.screenName ? { screenName: groupInfo.screenName } : {}),
        ...(webhookSetupHint ? { webhookSetupHint } : {}),
        ...(reloadError ? { reloadError } : {}),
      });
    } catch (err) {
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        return c.json({ error: "channel already exists", groupId }, 409);
      }
      throw err;
    }
  });

  /**
   * POST /api/admin/channels/web
   * Body: { externalId?, brandName?, primaryColor? }
   *
   * Enables web channel для tenant'а — создаёт `channels(kind='web')` row +
   * возвращает ready-to-paste embed snippet. Никаких external API вызовов
   * (в отличие от Telegram/WhatsApp), поэтому idempotent — повторный POST
   * с тем же externalId обновляет brand metadata.
   *
   * Errors:
   *   400 — bad json / externalId invalid
   *   402 — quota_exceeded (plan limit on channels)
   */
  app.post("/api/admin/channels/web", async (c) => {
    const tenantId = c.var.tenantId;
    // Body opt: пустой → enable без customization; не-пустой но bad json → 400.
    const raw = await c.req.text().catch(() => "");
    let body: WebCreateBody = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as WebCreateBody;
      } catch {
        return c.json({ error: "invalid json" }, 400);
      }
    }
    const externalIdInput =
      typeof body.externalId === "string" && body.externalId.trim() ? body.externalId.trim() : "";
    const brandName =
      typeof body.brandName === "string" && body.brandName.trim()
        ? body.brandName.trim()
        : undefined;
    const primaryColor =
      typeof body.primaryColor === "string" && /^#[0-9a-fA-F]{3,8}$/.test(body.primaryColor)
        ? body.primaryColor
        : undefined;

    if (externalIdInput && !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/i.test(externalIdInput)) {
      return c.json({ error: "externalId must be alphanumeric/dash, 3-64 chars" }, 400);
    }

    const [tenant] = await opts.db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) return c.json({ error: "tenant not found" }, 404);

    const externalId = externalIdInput || tenant.slug;
    const nowEpoch = Math.floor(Date.now() / 1000);

    // Quota check (только для new-channel path).
    const [maybeExistingWeb] = await opts.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.tenantId, tenantId),
          eq(channels.kind, "web"),
          eq(channels.externalId, externalId),
        ),
      );
    if (!maybeExistingWeb) {
      const quota = await canAddChannel({ db: opts.db, tenantId });
      if (!quota.allowed) {
        return c.json(
          {
            error: "quota_exceeded",
            reason: quota.reason,
            limit: quota.limit,
            current: quota.current,
            plan: quota.plan,
            planLabel: quota.planLabel,
            upgradeHint: "Перейдите на план Starter ($99/мес) для большего числа каналов",
          },
          402,
        );
      }
    }

    const metadata = JSON.stringify({
      ...(brandName ? { brandName } : {}),
      ...(primaryColor ? { primaryColor } : {}),
    });

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      if (maybeExistingWeb) {
        await tx
          .update(channels)
          .set({
            status: "active",
            metadataJson: metadata,
            updatedAt: nowEpoch,
          })
          .where(eq(channels.id, maybeExistingWeb.id));
        return { id: maybeExistingWeb.id, updated: true };
      }
      const [inserted] = await tx
        .insert(channels)
        .values({
          tenantId,
          kind: "web",
          externalId,
          status: "active",
          metadataJson: metadata,
          createdAt: nowEpoch,
          updatedAt: nowEpoch,
        })
        .returning({ id: channels.id });
      return { id: inserted!.id, updated: false };
    });

    await recordAudit(opts.db, {
      tenantId,
      adminId: c.var.adminId,
      action: result.updated ? "channel.update" : "channel.create",
      targetKind: "channel",
      targetId: result.id,
      details: {
        kind: "web",
        externalId,
        ...(brandName ? { brandName } : {}),
        ...(primaryColor ? { primaryColor } : {}),
      },
    });

    let reloadError: string | undefined;
    if (opts.onReload) {
      try {
        await opts.onReload(tenantId);
      } catch (err) {
        reloadError = err instanceof Error ? err.message : String(err);
      }
    }

    const snippet = opts.publicUrl
      ? generateWebWidgetSnippet({
          publicUrl: opts.publicUrl,
          tenantSlug: tenant.slug,
          externalId,
          webWidgetScriptUrl: opts.webWidgetScriptUrl,
          brandName,
          primaryColor,
          authSecret: undefined,
        })
      : undefined;

    return c.json({
      ok: true,
      ...result,
      externalId,
      ...(brandName ? { brandName } : {}),
      ...(primaryColor ? { primaryColor } : {}),
      ...(snippet
        ? { snippet }
        : {
            snippetHint: "PLATFORM_PUBLIC_URL не задан — snippet нельзя сгенерировать",
          }),
      ...(reloadError ? { reloadError } : {}),
    });
  });

  /**
   * GET /api/admin/channels/web/snippet
   * Возвращает свежий snippet для уже-enabled web-channel'а. Если несколько
   * web-каналов — берём первый. 404 если ни одного нет.
   */
  app.get("/api/admin/channels/web/snippet", async (c) => {
    const tenantId = c.var.tenantId;
    const [tenant] = await opts.db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) return c.json({ error: "tenant not found" }, 404);

    const [ch] = await opts.db
      .select({
        externalId: channels.externalId,
        metadataJson: channels.metadataJson,
      })
      .from(channels)
      .where(
        and(
          eq(channels.tenantId, tenantId),
          eq(channels.kind, "web"),
          eq(channels.status, "active"),
        ),
      )
      .limit(1);
    if (!ch) return c.json({ error: "no active web channel" }, 404);

    let brandName: string | undefined;
    let primaryColor: string | undefined;
    if (ch.metadataJson) {
      try {
        const parsed = JSON.parse(ch.metadataJson) as {
          brandName?: string;
          primaryColor?: string;
        };
        brandName = parsed.brandName;
        primaryColor = parsed.primaryColor;
      } catch {
        // ignore malformed metadata
      }
    }

    if (!opts.publicUrl) {
      return c.json({ error: "PLATFORM_PUBLIC_URL not configured" }, 503);
    }
    const snippet = generateWebWidgetSnippet({
      publicUrl: opts.publicUrl,
      tenantSlug: tenant.slug,
      externalId: ch.externalId,
      webWidgetScriptUrl: opts.webWidgetScriptUrl,
      brandName,
      primaryColor,
      authSecret: undefined,
    });
    return c.json({
      ok: true,
      externalId: ch.externalId,
      ...(brandName ? { brandName } : {}),
      ...(primaryColor ? { primaryColor } : {}),
      snippet,
    });
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

    await recordAudit(opts.db, {
      tenantId,
      adminId: c.var.adminId,
      action: "channel.delete",
      targetKind: "channel",
      targetId: id,
    });

    if (opts.onReload) {
      try {
        await opts.onReload(tenantId);
      } catch (err) {
        return c.json({
          ok: true,
          deleted,
          reloadError: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({ ok: true, deleted });
  });

  // ── Telegram userbot (личный аккаунт, MTProto) onboarding ───────────────
  // Многошаговый stateful-логин: phone → code → (2fa). gramjs-client живёт
  // в userbotLoginStore между запросами. По завершении session шифруется в
  // tenant_secrets, создаётся channels row, reloader поднимает adapter.
  //
  // Доступно любому тенанту: каждый подключает свой личный аккаунт (скоуп по tenantId).

  // Userbot-онбординг доступен всегда, когда есть login-store. MTProto-креды
  // (api_id/api_hash) резолвятся per-request: тело запроса → tenant_secrets →
  // env-фолбэк (opts.telegramApiId/Hash). Если кредов нет нигде — /start отдаёт 400.
  const userbotEnabled = () => !!opts.userbotLoginStore;

  /** Маппинг UserbotLoginError → HTTP-код + тело для UI. */
  function loginErrorResponse(err: unknown) {
    if (err instanceof UserbotLoginError) {
      const status =
        err.code === "flood_wait"
          ? 429
          : err.code === "code_expired"
            ? 410
            : err.code === "unknown"
              ? 502
              : 400;
      return {
        body: {
          error: err.code,
          message: err.message,
          ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}),
        },
        status: status as 400 | 410 | 429 | 502,
      };
    }
    return {
      body: {
        error: "userbot_login_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      status: 502 as const,
    };
  }

  /**
   * Финализация логина: encrypt session + upsert channels row + audit + reload.
   * Дисконнектит login-client (registry поднимет свежий adapter из сессии).
   */
  async function finalizeUserbot(c: Context, loginId: string, finished: FinishedUserbotLogin) {
    const tenantId = c.var.tenantId;
    const nowEpoch = Math.floor(Date.now() / 1000);
    const externalId = finished.userId;
    const secretKey = `channel_telegram_userbot_${externalId}`;
    const metadataJson = JSON.stringify({
      username: finished.username,
      phone: finished.phone,
    });

    const [existing] = await opts.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.tenantId, tenantId),
          eq(channels.kind, "telegram_userbot"),
          eq(channels.externalId, externalId),
        ),
      );

    if (!existing) {
      const quota = await canAddChannel({ db: opts.db, tenantId });
      if (!quota.allowed) {
        await opts.userbotLoginStore?.discard(loginId);
        return c.json(
          {
            error: "quota_exceeded",
            reason: quota.reason,
            limit: quota.limit,
            current: quota.current,
            plan: quota.plan,
            planLabel: quota.planLabel,
            upgradeHint: "Перейдите на план Starter ($99/мес) для большего числа каналов",
          },
          402,
        );
      }
    }

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      await setEncryptedSecret({
        db: tx,
        tenantId,
        key: secretKey,
        value: finished.sessionString,
        masterKeyHex: opts.masterKeyHex,
        nowEpoch,
      });
      if (existing) {
        await tx
          .update(channels)
          .set({
            credentialsRef: secretKey,
            status: "active",
            metadataJson,
            updatedAt: nowEpoch,
          })
          .where(eq(channels.id, existing.id));
        return { id: existing.id, updated: true };
      }
      const [inserted] = await tx
        .insert(channels)
        .values({
          tenantId,
          kind: "telegram_userbot",
          externalId,
          credentialsRef: secretKey,
          status: "active",
          metadataJson,
          createdAt: nowEpoch,
          updatedAt: nowEpoch,
        })
        .returning({ id: channels.id });
      return { id: inserted!.id, updated: false };
    });

    // Login-client больше не нужен — registry поднимет свежий adapter из сессии.
    await opts.userbotLoginStore?.discard(loginId);

    await recordAudit(opts.db, {
      tenantId,
      adminId: c.var.adminId,
      action: result.updated ? "channel.update" : "channel.create",
      targetKind: "channel",
      targetId: result.id,
      details: {
        kind: "telegram_userbot",
        userId: externalId,
        username: finished.username,
      },
    });

    let reloadError: string | undefined;
    if (opts.onReload) {
      try {
        await opts.onReload(tenantId);
      } catch (err) {
        reloadError = err instanceof Error ? err.message : String(err);
      }
    }

    return c.json({
      ok: true,
      ...result,
      externalId,
      username: finished.username,
      ...(reloadError ? { reloadError } : {}),
    });
  }

  app.post("/api/admin/channels/userbot/start", async (c) => {
    if (!userbotEnabled()) {
      return c.json({ error: "userbot_disabled" }, 503);
    }
    let body: { phone?: unknown; apiId?: unknown; apiHash?: unknown };
    try {
      body = (await c.req.json()) as { phone?: unknown; apiId?: unknown; apiHash?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!/^\+?\d{7,15}$/.test(phone)) {
      return c.json(
        {
          error: "phone_invalid",
          message: "Укажите номер в формате +79991234567",
        },
        400,
      );
    }

    // Креды из тела (если тенант ввёл свои) — валидируем и сохраняем ДО логина,
    // чтобы registry мог переподключаться по ним позже.
    const tenantId = c.var.tenantId;
    const rawApiId =
      typeof body.apiId === "string" || typeof body.apiId === "number"
        ? Number.parseInt(String(body.apiId).trim(), 10)
        : Number.NaN;
    const rawApiHash = typeof body.apiHash === "string" ? body.apiHash.trim() : "";
    if (rawApiHash || !Number.isNaN(rawApiId)) {
      if (!(rawApiId > 0) || !rawApiHash) {
        return c.json(
          {
            error: "userbot_creds_invalid",
            message: "Укажите оба значения: API ID (число) и API Hash",
          },
          400,
        );
      }
      await withTenant(opts.db, tenantId, async (tx) => {
        await setUserbotCreds({
          db: tx,
          tenantId,
          apiId: rawApiId,
          apiHash: rawApiHash,
          masterKeyHex: opts.masterKeyHex,
          nowEpoch: Math.floor(Date.now() / 1000),
        });
      });
    }

    // Резолв эффективных кредов: tenant_secrets (только что сохранённые или
    // прежние) → env-фолбэк.
    const creds = await resolveUserbotCreds({
      db: opts.db,
      tenantId,
      masterKeyHex: opts.masterKeyHex,
      fallbackApiId: opts.telegramApiId,
      fallbackApiHash: opts.telegramApiHash,
    });
    if (!creds) {
      return c.json(
        {
          error: "userbot_creds_required",
          message: "Укажите API ID и API Hash (my.telegram.org → API development tools)",
        },
        400,
      );
    }
    try {
      const started = await startUserbotLogin({
        apiId: creds.apiId,
        apiHash: creds.apiHash,
        phone,
      });
      const loginId = randomUUID();
      opts.userbotLoginStore?.create({
        loginId,
        client: started.client,
        phoneCodeHash: started.phoneCodeHash,
        phone,
        tenantId: c.var.tenantId,
      });
      return c.json({ ok: true, loginId, awaiting: "code" });
    } catch (err) {
      const { body: errBody, status } = loginErrorResponse(err);
      return c.json(errBody, status);
    }
  });

  app.post("/api/admin/channels/userbot/verify", async (c) => {
    if (!userbotEnabled()) return c.json({ error: "userbot_disabled" }, 503);
    let body: { loginId?: unknown; code?: unknown };
    try {
      body = (await c.req.json()) as { loginId?: unknown; code?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const loginId = typeof body.loginId === "string" ? body.loginId : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!loginId || !code) return c.json({ error: "loginId and code required" }, 400);
    const pending = opts.userbotLoginStore?.get(loginId, c.var.tenantId);
    if (!pending) {
      return c.json(
        {
          error: "login_expired",
          message: "Сессия логина истекла — начните заново",
        },
        410,
      );
    }
    try {
      const res = await submitUserbotCode({
        client: pending.client,
        phone: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
        code,
      });
      if (res.needs2fa) {
        opts.userbotLoginStore?.markAwaiting2fa(loginId);
        return c.json({ ok: true, awaiting: "2fa" });
      }
      return finalizeUserbot(c, loginId, res);
    } catch (err) {
      const { body: errBody, status } = loginErrorResponse(err);
      return c.json(errBody, status);
    }
  });

  app.post("/api/admin/channels/userbot/2fa", async (c) => {
    if (!userbotEnabled()) return c.json({ error: "userbot_disabled" }, 503);
    let body: { loginId?: unknown; password?: unknown };
    try {
      body = (await c.req.json()) as { loginId?: unknown; password?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const loginId = typeof body.loginId === "string" ? body.loginId : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!loginId || !password) return c.json({ error: "loginId and password required" }, 400);
    const pending = opts.userbotLoginStore?.get(loginId, c.var.tenantId);
    if (!pending) {
      return c.json(
        {
          error: "login_expired",
          message: "Сессия логина истекла — начните заново",
        },
        410,
      );
    }
    try {
      const finished = await submitUserbot2fa({
        client: pending.client,
        password,
      });
      return finalizeUserbot(c, loginId, finished);
    } catch (err) {
      const { body: errBody, status } = loginErrorResponse(err);
      return c.json(errBody, status);
    }
  });

  return app;
}
