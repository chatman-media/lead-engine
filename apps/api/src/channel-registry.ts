import { TelegramBotAdapter } from "@chatman-media/channel-telegram";
import { channels, tenants, tenantSecrets } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

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
 * Per-tenant decryption секретов будет добавлен в следующей миграции —
 * сейчас credentials_ref резолвится как plain-text имя env-переменной
 * (упрощение для single-tenant legacy deploy).
 */
export interface ChannelEntry {
  channelDbId: number;
  tenantId: number;
  tenantSlug: string;
  kind: "telegram_bot" | "telegram_userbot" | "whatsapp" | "web";
  externalId: string;
  adapter: TelegramBotAdapter; // в будущем — union с другими adapter-классами
}

export class ChannelRegistry {
  private readonly byTenantSlug = new Map<string, ChannelEntry[]>();
  private readonly byDbId = new Map<number, ChannelEntry>();

  /**
   * Резолв per-tenant credentials. Сейчас минимальный shim для legacy
   * tenant'а: bot-token берётся из env BOT_TOKEN_<tenantSlug> (или
   * fallback BOT_TOKEN). После Этапа 8 — расшифровка tenant_secrets с
   * masterKey + AES-256-GCM.
   */
  private resolveBotToken(tenantSlug: string): string | null {
    const envKey = `BOT_TOKEN_${tenantSlug.toUpperCase().replace(/-/g, "_")}`;
    return process.env[envKey] ?? process.env.BOT_TOKEN ?? null;
  }

  async loadFromDb(
    db: PostgresJsDatabase<{ channels: typeof channels; tenants: typeof tenants; tenantSecrets: typeof tenantSecrets }>,
  ): Promise<void> {
    const rows = await db
      .select({
        channelId: channels.id,
        kind: channels.kind,
        externalId: channels.externalId,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
      })
      .from(channels)
      .innerJoin(tenants, eq(tenants.id, channels.tenantId))
      .where(and(eq(channels.status, "active"), eq(tenants.status, "active")));

    for (const row of rows) {
      // На текущей stage поддерживаем только telegram_bot — остальные
      // адаптеры приходят в Этап 2b-cont (MTProto) и далее (WhatsApp).
      if (row.kind !== "telegram_bot") continue;
      const token = this.resolveBotToken(row.tenantSlug);
      if (!token) continue;
      const adapter = new TelegramBotAdapter({
        id: String(row.channelId),
        token,
      });
      const entry: ChannelEntry = {
        channelDbId: row.channelId,
        tenantId: row.tenantId,
        tenantSlug: row.tenantSlug,
        kind: row.kind as "telegram_bot",
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

  byChannelId(channelId: number): ChannelEntry | undefined {
    return this.byDbId.get(channelId);
  }

  closeAll(): void {
    for (const entry of this.byDbId.values()) {
      entry.adapter.close();
    }
  }
}
