import { MessengerAdapter } from "@chatman-media/channel-facebook";
import { MaxAdapter } from "@chatman-media/channel-max";
import { TelegramBotAdapter } from "@chatman-media/channel-telegram";
import { type Db, getDecryptedSecret } from "@chatman-media/conversation-engine";
import { VkAdapter } from "@chatman-media/channel-vk";
import { WhatsAppCloudAdapter } from "@chatman-media/channel-whatsapp";
import { channels, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";

/**
 * Реестр живых ChannelAdapter'ов в процессе apps/api. На boot загружает
 * активные channels из БД, инстанциирует адаптеры с per-tenant
 * credentials. apps/worker делает то же самое (но также крутит
 * receive()-loop'ы для каждого).
 *
 * Здесь, в api, адаптеры нужны только чтобы pushUpdate() из webhook-
 * handler'а попадал в правильный exposed Inbound-stream. Реальный
 * receive() & dispatch — в worker'е.
 *
 * Credentials resolution:
 *   1. Если `channels.credentials_ref` указывает на ключ в `tenant_secrets`,
 *      decrypt'им AES-256-GCM (per-tenant ключ хранится зашифрованным).
 *   2. Если decrypt failed или secret отсутствует — env fallback
 *      (BOT_TOKEN_<SLUG> / WA_ACCESS_TOKEN_<SLUG>) для legacy single-tenant.
 *
 * Hot-reload не поддерживается — добавление channel через UI требует
 * рестарта apps/api. См. todo в admin-channels.ts.
 */
/** tenant_secrets ключи для per-tenant Meta webhook creds. */
export const WHATSAPP_VERIFY_TOKEN_KEY = "whatsapp_verify_token";
export const WHATSAPP_APP_SECRET_KEY = "whatsapp_app_secret";
/** tenant_secrets ключи для per-tenant Facebook Messenger webhook creds. */
export const FACEBOOK_VERIFY_TOKEN_KEY = "facebook_verify_token";
export const FACEBOOK_APP_SECRET_KEY = "facebook_app_secret";
/** tenant_secrets ключи для per-tenant VK Callback API creds. */
export const VK_CONFIRMATION_CODE_KEY = "vk_confirmation_code";
export const VK_SECRET_KEY = "vk_secret_key";
/** tenant_secrets suffix для per-channel MAX webhook secret. */
export const MAX_WEBHOOK_SECRET_SUFFIX = "_webhook_secret";

export function maxWebhookSecretKey(credentialsRef: string): string {
  return `${credentialsRef}${MAX_WEBHOOK_SECRET_SUFFIX}`;
}

export interface ChannelEntry {
  channelDbId: number;
  tenantId: number;
  tenantSlug: string;
  /** Plan tier строки из tenants.plan — используется для per-plan rate limits. */
  tenantPlan: string;
  kind: "telegram_bot" | "telegram_userbot" | "whatsapp" | "facebook" | "vk" | "max" | "web";
  externalId: string;
  /** Конкретный adapter в зависимости от kind. */
  adapter: TelegramBotAdapter | WhatsAppCloudAdapter | MessengerAdapter | VkAdapter | MaxAdapter;
  /** WhatsApp: per-tenant verify_token (резолвится при загрузке, фолбэк env). */
  whatsappVerifyToken?: string;
  /** WhatsApp: per-tenant app secret для X-Hub-Signature-256 (фолбэк env). */
  whatsappAppSecret?: string;
  /** Facebook: per-tenant verify_token (резолвится при загрузке, фолбэк env). */
  facebookVerifyToken?: string;
  /** Facebook: per-tenant app secret для X-Hub-Signature-256 (фолбэк env). */
  facebookAppSecret?: string;
  /** VK: confirmation code для Callback API setup. */
  vkConfirmationCode?: string;
  /** VK: secret key из Callback API settings, валидируется по payload.secret. */
  vkSecretKey?: string;
  /** MAX: secret для X-Max-Bot-Api-Secret header. */
  maxWebhookSecret?: string;
}

export interface LoadFromDbOpts {
  /** Master-key для расшифровки tenant_secrets. Если не задан — только env fallback. */
  masterKeyHex?: string;
  /** Logger hook для warning'ов о decrypt-ошибках. */
  onWarn?: (msg: string, ctx: Record<string, unknown>) => void;
  /** Env-фолбэк WhatsApp verify_token (WHATSAPP_VERIFY_TOKEN). */
  whatsappVerifyTokenFallback?: string;
  /** Env-фолбэк WhatsApp app secret (WHATSAPP_APP_SECRET). */
  whatsappAppSecretFallback?: string;
  /** Env-фолбэк Facebook verify_token (FACEBOOK_VERIFY_TOKEN). */
  facebookVerifyTokenFallback?: string;
  /** Env-фолбэк Facebook app secret (FACEBOOK_APP_SECRET). */
  facebookAppSecretFallback?: string;
  /** Env-фолбэк VK confirmation code (VK_CONFIRMATION_CODE). */
  vkConfirmationCodeFallback?: string;
  /** Env-фолбэк VK Callback API secret key (VK_SECRET_KEY). */
  vkSecretKeyFallback?: string;
  /** Env-фолбэк MAX webhook secret (MAX_WEBHOOK_SECRET). */
  maxWebhookSecretFallback?: string;
}

export class ChannelRegistry {
  private readonly byTenantSlug = new Map<string, ChannelEntry[]>();
  private readonly byDbId = new Map<number, ChannelEntry>();

  /**
   * Резолв per-tenant credentials. Priority:
   *   1. tenant_secrets[credentialsRef] (decrypt AES-256-GCM) — если есть.
   *   2. env BOT_TOKEN_<SLUG> → BOT_TOKEN (legacy single-tenant).
   */
  private async resolveBotToken(
    db: Db,
    tenantId: number,
    tenantSlug: string,
    credentialsRef: string | null,
    masterKeyHex: string | undefined,
    onWarn: ((msg: string, ctx: Record<string, unknown>) => void) | undefined,
  ): Promise<string | null> {
    if (credentialsRef && masterKeyHex) {
      try {
        const decrypted = await getDecryptedSecret({
          db,
          tenantId,
          key: credentialsRef,
          masterKeyHex,
        });
        if (decrypted) return decrypted;
      } catch (err) {
        onWarn?.("failed to decrypt channel bot token", {
          tenantId,
          tenantSlug,
          credentialsRef,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const envKey = `BOT_TOKEN_${tenantSlug.toUpperCase().replace(/-/g, "_")}`;
    return process.env[envKey] ?? process.env.BOT_TOKEN ?? null;
  }

  /**
   * Аналогично resolveBotToken: сначала tenant_secrets, потом env.
   */
  private async resolveWhatsAppToken(
    db: Db,
    tenantId: number,
    tenantSlug: string,
    credentialsRef: string | null,
    masterKeyHex: string | undefined,
    onWarn: ((msg: string, ctx: Record<string, unknown>) => void) | undefined,
  ): Promise<string | null> {
    if (credentialsRef && masterKeyHex) {
      try {
        const decrypted = await getDecryptedSecret({
          db,
          tenantId,
          key: credentialsRef,
          masterKeyHex,
        });
        if (decrypted) return decrypted;
      } catch (err) {
        onWarn?.("failed to decrypt channel whatsapp token", {
          tenantId,
          tenantSlug,
          credentialsRef,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const envKey = `WA_ACCESS_TOKEN_${tenantSlug.toUpperCase().replace(/-/g, "_")}`;
    return process.env[envKey] ?? process.env.WA_ACCESS_TOKEN ?? null;
  }

  /**
   * Резолв per-tenant Meta webhook creds (verify_token + app_secret) при
   * загрузке канала. Сначала tenant_secrets, потом env-фолбэк из loadOpts.
   * Кешируется в ChannelEntry — webhook не дешифрует на каждый POST.
   */
  private async resolveWhatsAppWebhookCreds(
    db: Db,
    tenantId: number,
  ): Promise<{ verifyToken: string | undefined; appSecret: string | undefined }> {
    const read = async (key: string): Promise<string | undefined> => {
      if (!this.loadOpts.masterKeyHex) return undefined;
      try {
        return (
          (await getDecryptedSecret({
            db,
            tenantId,
            key,
            masterKeyHex: this.loadOpts.masterKeyHex,
          })) ?? undefined
        );
      } catch (err) {
        this.loadOpts.onWarn?.("failed to decrypt whatsapp webhook creds", {
          tenantId,
          key,
          err: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    };
    const [verify, secret] = await Promise.all([
      read(WHATSAPP_VERIFY_TOKEN_KEY),
      read(WHATSAPP_APP_SECRET_KEY),
    ]);
    return {
      verifyToken: verify || this.loadOpts.whatsappVerifyTokenFallback || undefined,
      appSecret: secret || this.loadOpts.whatsappAppSecretFallback || undefined,
    };
  }

  /** Аналогично resolveWhatsAppToken: сначала tenant_secrets, потом env. */
  private async resolveFacebookToken(
    db: Db,
    tenantId: number,
    tenantSlug: string,
    credentialsRef: string | null,
    masterKeyHex: string | undefined,
    onWarn: ((msg: string, ctx: Record<string, unknown>) => void) | undefined,
  ): Promise<string | null> {
    if (credentialsRef && masterKeyHex) {
      try {
        const decrypted = await getDecryptedSecret({
          db,
          tenantId,
          key: credentialsRef,
          masterKeyHex,
        });
        if (decrypted) return decrypted;
      } catch (err) {
        onWarn?.("failed to decrypt channel facebook token", {
          tenantId,
          tenantSlug,
          credentialsRef,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const envKey = `FB_PAGE_TOKEN_${tenantSlug.toUpperCase().replace(/-/g, "_")}`;
    return process.env[envKey] ?? process.env.FB_PAGE_TOKEN ?? null;
  }

  /** Аналогично Meta-каналам: tenant_secrets → env VK_ACCESS_TOKEN_<SLUG> → env VK_ACCESS_TOKEN. */
  private async resolveVkToken(
    db: Db,
    tenantId: number,
    tenantSlug: string,
    credentialsRef: string | null,
    masterKeyHex: string | undefined,
    onWarn: ((msg: string, ctx: Record<string, unknown>) => void) | undefined,
  ): Promise<string | null> {
    if (credentialsRef && masterKeyHex) {
      try {
        const decrypted = await getDecryptedSecret({
          db,
          tenantId,
          key: credentialsRef,
          masterKeyHex,
        });
        if (decrypted) return decrypted;
      } catch (err) {
        onWarn?.("failed to decrypt channel vk token", {
          tenantId,
          tenantSlug,
          credentialsRef,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const envKey = `VK_ACCESS_TOKEN_${tenantSlug.toUpperCase().replace(/-/g, "_")}`;
    return process.env[envKey] ?? process.env.VK_ACCESS_TOKEN ?? null;
  }

  /** Аналогично VK/Meta: tenant_secrets → env MAX_BOT_TOKEN_<SLUG> → env MAX_BOT_TOKEN. */
  private async resolveMaxToken(
    db: Db,
    tenantId: number,
    tenantSlug: string,
    credentialsRef: string | null,
    masterKeyHex: string | undefined,
    onWarn: ((msg: string, ctx: Record<string, unknown>) => void) | undefined,
  ): Promise<string | null> {
    if (credentialsRef && masterKeyHex) {
      try {
        const decrypted = await getDecryptedSecret({
          db,
          tenantId,
          key: credentialsRef,
          masterKeyHex,
        });
        if (decrypted) return decrypted;
      } catch (err) {
        onWarn?.("failed to decrypt channel max token", {
          tenantId,
          tenantSlug,
          credentialsRef,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const envKey = `MAX_BOT_TOKEN_${tenantSlug.toUpperCase().replace(/-/g, "_")}`;
    return process.env[envKey] ?? process.env.MAX_BOT_TOKEN ?? null;
  }

  /** Резолв per-tenant Facebook webhook creds (verify_token + app_secret). */
  private async resolveFacebookWebhookCreds(
    db: Db,
    tenantId: number,
  ): Promise<{ verifyToken: string | undefined; appSecret: string | undefined }> {
    const read = async (key: string): Promise<string | undefined> => {
      if (!this.loadOpts.masterKeyHex) return undefined;
      try {
        return (
          (await getDecryptedSecret({
            db,
            tenantId,
            key,
            masterKeyHex: this.loadOpts.masterKeyHex,
          })) ?? undefined
        );
      } catch (err) {
        this.loadOpts.onWarn?.("failed to decrypt facebook webhook creds", {
          tenantId,
          key,
          err: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    };
    const [verify, secret] = await Promise.all([
      read(FACEBOOK_VERIFY_TOKEN_KEY),
      read(FACEBOOK_APP_SECRET_KEY),
    ]);
    return {
      verifyToken: verify || this.loadOpts.facebookVerifyTokenFallback || undefined,
      appSecret: secret || this.loadOpts.facebookAppSecretFallback || undefined,
    };
  }

  /** Резолв per-tenant VK Callback API creds (confirmation_code + secret_key). */
  private async resolveVkWebhookCreds(
    db: Db,
    tenantId: number,
  ): Promise<{ confirmationCode: string | undefined; secretKey: string | undefined }> {
    const read = async (key: string): Promise<string | undefined> => {
      if (!this.loadOpts.masterKeyHex) return undefined;
      try {
        return (
          (await getDecryptedSecret({
            db,
            tenantId,
            key,
            masterKeyHex: this.loadOpts.masterKeyHex,
          })) ?? undefined
        );
      } catch (err) {
        this.loadOpts.onWarn?.("failed to decrypt vk webhook creds", {
          tenantId,
          key,
          err: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    };
    const [confirmationCode, secretKey] = await Promise.all([
      read(VK_CONFIRMATION_CODE_KEY),
      read(VK_SECRET_KEY),
    ]);
    return {
      confirmationCode:
        confirmationCode || this.loadOpts.vkConfirmationCodeFallback || undefined,
      secretKey: secretKey || this.loadOpts.vkSecretKeyFallback || undefined,
    };
  }

  /** Резолв per-channel MAX webhook secret: tenant_secrets[credentialsRef + suffix] → env fallback. */
  private async resolveMaxWebhookSecret(
    db: Db,
    tenantId: number,
    credentialsRef: string | null,
  ): Promise<string | undefined> {
    if (!credentialsRef) return this.loadOpts.maxWebhookSecretFallback || undefined;
    if (!this.loadOpts.masterKeyHex) return this.loadOpts.maxWebhookSecretFallback || undefined;
    try {
      return (
        (await getDecryptedSecret({
          db,
          tenantId,
          key: maxWebhookSecretKey(credentialsRef),
          masterKeyHex: this.loadOpts.masterKeyHex,
        })) ||
        this.loadOpts.maxWebhookSecretFallback ||
        undefined
      );
    } catch (err) {
      this.loadOpts.onWarn?.("failed to decrypt max webhook secret", {
        tenantId,
        key: maxWebhookSecretKey(credentialsRef),
        err: err instanceof Error ? err.message : String(err),
      });
      return this.loadOpts.maxWebhookSecretFallback || undefined;
    }
  }

  /** Кеш opts чтобы reloadTenant использовал тот же masterKey + onWarn. */
  private loadOpts: LoadFromDbOpts = {};
  private dbRef: Db | null = null;

  async loadFromDb(db: Db, opts: LoadFromDbOpts = {}): Promise<void> {
    this.loadOpts = opts;
    this.dbRef = db;
    const rows = await db
      .select({
        channelId: channels.id,
        kind: channels.kind,
        externalId: channels.externalId,
        credentialsRef: channels.credentialsRef,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
        tenantPlan: tenants.plan,
      })
      .from(channels)
      .innerJoin(tenants, eq(tenants.id, channels.tenantId))
      .where(and(eq(channels.status, "active"), eq(tenants.status, "active")));

    for (const row of rows) {
      let adapter:
        | TelegramBotAdapter
        | WhatsAppCloudAdapter
        | MessengerAdapter
        | VkAdapter
        | MaxAdapter
        | null = null;
      let waWebhookCreds: { verifyToken: string | undefined; appSecret: string | undefined } = {
        verifyToken: undefined,
        appSecret: undefined,
      };
      let fbWebhookCreds: { verifyToken: string | undefined; appSecret: string | undefined } = {
        verifyToken: undefined,
        appSecret: undefined,
      };
      let vkWebhookCreds: { confirmationCode: string | undefined; secretKey: string | undefined } =
        {
          confirmationCode: undefined,
          secretKey: undefined,
        };
      let maxWebhookSecret: string | undefined;
      if (row.kind === "telegram_bot") {
        const token = await this.resolveBotToken(
          db,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          opts.masterKeyHex,
          opts.onWarn,
        );
        if (!token) continue;
        adapter = new TelegramBotAdapter({ id: String(row.channelId), token });
      } else if (row.kind === "whatsapp") {
        const token = await this.resolveWhatsAppToken(
          db,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          opts.masterKeyHex,
          opts.onWarn,
        );
        if (!token) continue;
        // external_id у whatsapp канала = phone_number_id (Meta).
        adapter = new WhatsAppCloudAdapter({
          id: String(row.channelId),
          phoneNumberId: row.externalId,
          accessToken: token,
        });
        waWebhookCreds = await this.resolveWhatsAppWebhookCreds(db, row.tenantId);
      } else if (row.kind === "facebook") {
        const token = await this.resolveFacebookToken(
          db,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          opts.masterKeyHex,
          opts.onWarn,
        );
        if (!token) continue;
        // external_id у facebook канала = Page ID (Meta).
        adapter = new MessengerAdapter({ id: String(row.channelId), pageAccessToken: token });
        fbWebhookCreds = await this.resolveFacebookWebhookCreds(db, row.tenantId);
      } else if (row.kind === "vk") {
        const token = await this.resolveVkToken(
          db,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          opts.masterKeyHex,
          opts.onWarn,
        );
        if (!token) continue;
        // external_id у vk канала = group_id сообщества.
        adapter = new VkAdapter({ id: String(row.channelId), accessToken: token });
        vkWebhookCreds = await this.resolveVkWebhookCreds(db, row.tenantId);
      } else if (row.kind === "max") {
        const token = await this.resolveMaxToken(
          db,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          opts.masterKeyHex,
          opts.onWarn,
        );
        if (!token) continue;
        adapter = new MaxAdapter({ id: String(row.channelId), accessToken: token });
        maxWebhookSecret = await this.resolveMaxWebhookSecret(
          db,
          row.tenantId,
          row.credentialsRef,
        );
      } else {
        // telegram_userbot и web в apps/api НЕ загружаются — userbot живёт
        // в apps/worker, web обрабатывается через отдельный WS-endpoint.
        continue;
      }
      const entry: ChannelEntry = {
        channelDbId: row.channelId,
        tenantId: row.tenantId,
        tenantSlug: row.tenantSlug,
        tenantPlan: row.tenantPlan,
        kind: row.kind as ChannelEntry["kind"],
        externalId: row.externalId,
        adapter,
        ...(waWebhookCreds.verifyToken ? { whatsappVerifyToken: waWebhookCreds.verifyToken } : {}),
        ...(waWebhookCreds.appSecret ? { whatsappAppSecret: waWebhookCreds.appSecret } : {}),
        ...(fbWebhookCreds.verifyToken ? { facebookVerifyToken: fbWebhookCreds.verifyToken } : {}),
        ...(fbWebhookCreds.appSecret ? { facebookAppSecret: fbWebhookCreds.appSecret } : {}),
        ...(vkWebhookCreds.confirmationCode
          ? { vkConfirmationCode: vkWebhookCreds.confirmationCode }
          : {}),
        ...(vkWebhookCreds.secretKey ? { vkSecretKey: vkWebhookCreds.secretKey } : {}),
        ...(maxWebhookSecret ? { maxWebhookSecret } : {}),
      };
      const list = this.byTenantSlug.get(row.tenantSlug) ?? [];
      list.push(entry);
      this.byTenantSlug.set(row.tenantSlug, list);
      this.byDbId.set(row.channelId, entry);
    }
  }

  /**
   * Hot-reload: re-load channel entries для одного tenant'а из БД.
   * Закрывает старые адаптеры, инстанциирует новые. Используется после
   * POST/DELETE /api/admin/channels через onReload callback.
   *
   * Idempotent: вызов с пустыми channels удаляет tenant entries; с теми же
   * channels — пересоздаст adapter'ы (token rotation).
   */
  async reloadTenant(tenantId: number, tenantSlug: string): Promise<void> {
    if (!this.dbRef) return; // не было loadFromDb — nothing to reload.

    // Close & remove existing entries для этого tenant'а.
    const existing = this.byTenantSlug.get(tenantSlug) ?? [];
    for (const entry of existing) {
      try {
        entry.adapter.close();
      } catch {
        // ignore close errors (already-closed adapter)
      }
      this.byDbId.delete(entry.channelDbId);
    }
    this.byTenantSlug.delete(tenantSlug);

    // Re-query channels for this tenant only.
    const rows = await this.dbRef
      .select({
        channelId: channels.id,
        kind: channels.kind,
        externalId: channels.externalId,
        credentialsRef: channels.credentialsRef,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
        tenantPlan: tenants.plan,
      })
      .from(channels)
      .innerJoin(tenants, eq(tenants.id, channels.tenantId))
      .where(
        and(
          eq(channels.tenantId, tenantId),
          eq(channels.status, "active"),
          eq(tenants.status, "active"),
        ),
      );

    for (const row of rows) {
      let adapter:
        | TelegramBotAdapter
        | WhatsAppCloudAdapter
        | MessengerAdapter
        | VkAdapter
        | MaxAdapter
        | null = null;
      let waWebhookCreds: { verifyToken: string | undefined; appSecret: string | undefined } = {
        verifyToken: undefined,
        appSecret: undefined,
      };
      let fbWebhookCreds: { verifyToken: string | undefined; appSecret: string | undefined } = {
        verifyToken: undefined,
        appSecret: undefined,
      };
      let vkWebhookCreds: { confirmationCode: string | undefined; secretKey: string | undefined } =
        {
          confirmationCode: undefined,
          secretKey: undefined,
        };
      let maxWebhookSecret: string | undefined;
      if (row.kind === "telegram_bot") {
        const token = await this.resolveBotToken(
          this.dbRef,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          this.loadOpts.masterKeyHex,
          this.loadOpts.onWarn,
        );
        if (!token) continue;
        adapter = new TelegramBotAdapter({ id: String(row.channelId), token });
      } else if (row.kind === "whatsapp") {
        const token = await this.resolveWhatsAppToken(
          this.dbRef,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          this.loadOpts.masterKeyHex,
          this.loadOpts.onWarn,
        );
        if (!token) continue;
        adapter = new WhatsAppCloudAdapter({
          id: String(row.channelId),
          phoneNumberId: row.externalId,
          accessToken: token,
        });
        waWebhookCreds = await this.resolveWhatsAppWebhookCreds(this.dbRef, row.tenantId);
      } else if (row.kind === "facebook") {
        const token = await this.resolveFacebookToken(
          this.dbRef,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          this.loadOpts.masterKeyHex,
          this.loadOpts.onWarn,
        );
        if (!token) continue;
        adapter = new MessengerAdapter({ id: String(row.channelId), pageAccessToken: token });
        fbWebhookCreds = await this.resolveFacebookWebhookCreds(this.dbRef, row.tenantId);
      } else if (row.kind === "vk") {
        const token = await this.resolveVkToken(
          this.dbRef,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          this.loadOpts.masterKeyHex,
          this.loadOpts.onWarn,
        );
        if (!token) continue;
        adapter = new VkAdapter({ id: String(row.channelId), accessToken: token });
        vkWebhookCreds = await this.resolveVkWebhookCreds(this.dbRef, row.tenantId);
      } else if (row.kind === "max") {
        const token = await this.resolveMaxToken(
          this.dbRef,
          row.tenantId,
          row.tenantSlug,
          row.credentialsRef,
          this.loadOpts.masterKeyHex,
          this.loadOpts.onWarn,
        );
        if (!token) continue;
        adapter = new MaxAdapter({ id: String(row.channelId), accessToken: token });
        maxWebhookSecret = await this.resolveMaxWebhookSecret(
          this.dbRef,
          row.tenantId,
          row.credentialsRef,
        );
      } else {
        continue;
      }
      const entry: ChannelEntry = {
        channelDbId: row.channelId,
        tenantId: row.tenantId,
        tenantSlug: row.tenantSlug,
        tenantPlan: row.tenantPlan,
        kind: row.kind as ChannelEntry["kind"],
        externalId: row.externalId,
        adapter,
        ...(waWebhookCreds.verifyToken ? { whatsappVerifyToken: waWebhookCreds.verifyToken } : {}),
        ...(waWebhookCreds.appSecret ? { whatsappAppSecret: waWebhookCreds.appSecret } : {}),
        ...(fbWebhookCreds.verifyToken ? { facebookVerifyToken: fbWebhookCreds.verifyToken } : {}),
        ...(fbWebhookCreds.appSecret ? { facebookAppSecret: fbWebhookCreds.appSecret } : {}),
        ...(vkWebhookCreds.confirmationCode
          ? { vkConfirmationCode: vkWebhookCreds.confirmationCode }
          : {}),
        ...(vkWebhookCreds.secretKey ? { vkSecretKey: vkWebhookCreds.secretKey } : {}),
        ...(maxWebhookSecret ? { maxWebhookSecret } : {}),
      };
      const list = this.byTenantSlug.get(row.tenantSlug) ?? [];
      list.push(entry);
      this.byTenantSlug.set(row.tenantSlug, list);
      this.byDbId.set(row.channelId, entry);
    }
  }

  /** Все Telegram-bot каналы для tenant'а — webhook handler ищет здесь. */
  getTelegramBotsByTenant(tenantSlug: string): ChannelEntry[] {
    return (this.byTenantSlug.get(tenantSlug) ?? []).filter((e) => e.kind === "telegram_bot");
  }

  /** Все WhatsApp Cloud каналы для tenant'а. */
  getWhatsAppByTenant(tenantSlug: string): ChannelEntry[] {
    return (this.byTenantSlug.get(tenantSlug) ?? []).filter((e) => e.kind === "whatsapp");
  }

  /** Все Facebook Messenger каналы для tenant'а. */
  getFacebookByTenant(tenantSlug: string): ChannelEntry[] {
    return (this.byTenantSlug.get(tenantSlug) ?? []).filter((e) => e.kind === "facebook");
  }

  /** Все VK community каналы для tenant'а. */
  getVkByTenant(tenantSlug: string): ChannelEntry[] {
    return (this.byTenantSlug.get(tenantSlug) ?? []).filter((e) => e.kind === "vk");
  }

  /** Все MAX bot каналы для tenant'а. */
  getMaxByTenant(tenantSlug: string): ChannelEntry[] {
    return (this.byTenantSlug.get(tenantSlug) ?? []).filter((e) => e.kind === "max");
  }

  byChannelId(channelId: number): ChannelEntry | undefined {
    return this.byDbId.get(channelId);
  }

  closeAll(): void {
    for (const entry of this.byDbId.values()) {
      entry.adapter.close();
    }
  }
  size(): number {
    return this.byDbId.size;
  }
}
