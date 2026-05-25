import { randomUUID } from "node:crypto";
import {
  type FinishedUserbotLogin,
  startUserbotLogin,
  submitUserbot2fa,
  submitUserbotCode,
  TelegramApiError,
  TelegramClient,
  UserbotLoginError,
} from "@chatman-media/channel-telegram";
import { WhatsAppApiError, WhatsAppClient } from "@chatman-media/channel-whatsapp";
import { type Db, setEncryptedSecret, withTenant } from "@chatman-media/conversation-engine";
import { channels, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { canAddChannel } from "../lib/quota.ts";
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
            verifyToken: opts.whatsappVerifyToken ?? "<set WHATSAPP_VERIFY_TOKEN env>",
            appSecretHint:
              "Meta dashboard → App settings → Basic → App Secret — добавить в WHATSAPP_APP_SECRET env",
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
  // Только superadmin: подключается личный аккаунт организации.

  const userbotEnabled = () =>
    !!opts.userbotLoginStore && !!opts.telegramApiId && !!opts.telegramApiHash;

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
    if (c.var.role !== "superadmin") {
      return c.json({ error: "forbidden", message: "Только superadmin" }, 403);
    }
    if (!userbotEnabled()) {
      return c.json(
        {
          error: "userbot_disabled",
          message: "TELEGRAM_API_ID/HASH не заданы",
        },
        503,
      );
    }
    let body: { phone?: unknown };
    try {
      body = (await c.req.json()) as { phone?: unknown };
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
    try {
      const started = await startUserbotLogin({
        apiId: opts.telegramApiId as number,
        apiHash: opts.telegramApiHash as string,
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
    if (c.var.role !== "superadmin") {
      return c.json({ error: "forbidden" }, 403);
    }
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
    if (c.var.role !== "superadmin") {
      return c.json({ error: "forbidden" }, 403);
    }
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
