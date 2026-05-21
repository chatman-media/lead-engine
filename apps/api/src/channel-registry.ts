import { TelegramBotAdapter } from "@chatman-media/channel-telegram";
import { type Db, getDecryptedSecret } from "@chatman-media/conversation-engine";
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
export interface ChannelEntry {
  channelDbId: number;
  tenantId: number;
  tenantSlug: string;
  kind: "telegram_bot" | "telegram_userbot" | "whatsapp" | "web";
  externalId: string;
  /** Конкретный adapter в зависимости от kind. */
  adapter: TelegramBotAdapter | WhatsAppCloudAdapter;
}

export interface LoadFromDbOpts {
  /** Master-key для расшифровки tenant_secrets. Если не задан — только env fallback. */
  masterKeyHex?: string;
  /** Logger hook для warning'ов о decrypt-ошибках. */
  onWarn?: (msg: string, ctx: Record<string, unknown>) => void;
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

  async loadFromDb(db: Db, opts: LoadFromDbOpts = {}): Promise<void> {
    const rows = await db
      .select({
        channelId: channels.id,
        kind: channels.kind,
        externalId: channels.externalId,
        credentialsRef: channels.credentialsRef,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
      })
      .from(channels)
      .innerJoin(tenants, eq(tenants.id, channels.tenantId))
      .where(and(eq(channels.status, "active"), eq(tenants.status, "active")));

    for (const row of rows) {
      let adapter: TelegramBotAdapter | WhatsAppCloudAdapter | null = null;
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
      } else {
        // telegram_userbot и web в apps/api НЕ загружаются — userbot живёт
        // в apps/worker, web обрабатывается через отдельный WS-endpoint.
        continue;
      }
      const entry: ChannelEntry = {
        channelDbId: row.channelId,
        tenantId: row.tenantId,
        tenantSlug: row.tenantSlug,
        kind: row.kind as ChannelEntry["kind"],
        externalId: row.externalId,
        adapter,
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
