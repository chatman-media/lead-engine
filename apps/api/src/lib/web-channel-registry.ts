import { WebChannelAdapter } from "@chatman-media/channel-web";
import { channels, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Registry для in-process `WebChannelAdapter`'ов в apps/api. Один adapter
 * на `channels.id` (web kind, status='active'). Управляется boot'ом
 * `loadFromDb()` + опциональный `ensureForChannelId()` для hot-discovery
 * новых channel-rows без рестарта.
 *
 * В отличие от `ChannelRegistry` (telegram/whatsapp) — web-адаптер
 * stateful и держит pinned WebSocket-connection'ы per externalUserId.
 * Поэтому он живёт здесь, а не в worker'е: worker не примет HTTP-upgrade.
 */
export interface WebChannelEntry {
  channelDbId: number;
  tenantId: number;
  tenantSlug: string;
  externalId: string;
  adapter: WebChannelAdapter;
}

type DbType = PostgresJsDatabase<{ channels: typeof channels; tenants: typeof tenants }>;

export class WebChannelRegistry {
  private readonly byChannelDbId = new Map<number, WebChannelEntry>();
  private readonly byTenantSlug = new Map<string, WebChannelEntry>();
  private dbRef: DbType | null = null;

  async loadFromDb(db: DbType): Promise<void> {
    this.dbRef = db;
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
      .where(
        and(eq(channels.kind, "web"), eq(channels.status, "active"), eq(tenants.status, "active")),
      );

    for (const row of rows) {
      this.set({
        channelDbId: row.channelId,
        tenantId: row.tenantId,
        tenantSlug: row.tenantSlug,
        externalId: row.externalId,
        adapter: new WebChannelAdapter({ id: String(row.channelId) }),
      });
    }
  }

  /**
   * Hot-reload web-каналов для одного tenant'а. Закрывает старые WS-
   * адаптеры (разрывает pinned connection'ы), затем re-query DB +
   * instantiates новые. Inbound runner поднимается только на boot
   * apps/api, но WS upgrade'ы через ws-web.ts.tryUpgrade сразу видят
   * новые entries; outbound через WebOutboundDispatcher poll'ит DB
   * напрямую — kind='web' rows подхватываются без runner'а.
   */
  async reloadTenant(tenantId: number, tenantSlug: string): Promise<void> {
    if (!this.dbRef) return;
    // Close old adapters для этого tenant'а.
    for (const [chId, entry] of [...this.byChannelDbId]) {
      if (entry.tenantId === tenantId) {
        try {
          entry.adapter.close();
        } catch {
          // ignore close errors
        }
        this.byChannelDbId.delete(chId);
      }
    }
    this.byTenantSlug.delete(tenantSlug);

    const rows = await this.dbRef
      .select({
        channelId: channels.id,
        externalId: channels.externalId,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
      })
      .from(channels)
      .innerJoin(tenants, eq(tenants.id, channels.tenantId))
      .where(
        and(
          eq(channels.tenantId, tenantId),
          eq(channels.kind, "web"),
          eq(channels.status, "active"),
          eq(tenants.status, "active"),
        ),
      );

    for (const row of rows) {
      this.set({
        channelDbId: row.channelId,
        tenantId: row.tenantId,
        tenantSlug: row.tenantSlug,
        externalId: row.externalId,
        adapter: new WebChannelAdapter({ id: String(row.channelId) }),
      });
    }
  }

  private set(entry: WebChannelEntry): void {
    this.byChannelDbId.set(entry.channelDbId, entry);
    // На текущем этапе один web-канал на tenant'а. Если будет несколько
    // (custom routing по поддомену), индекс перепроектируется.
    this.byTenantSlug.set(entry.tenantSlug, entry);
  }

  byTenant(tenantSlug: string): WebChannelEntry | undefined {
    return this.byTenantSlug.get(tenantSlug);
  }

  byChannelId(channelDbId: number): WebChannelEntry | undefined {
    return this.byChannelDbId.get(channelDbId);
  }

  entries(): WebChannelEntry[] {
    return Array.from(this.byChannelDbId.values());
  }

  size(): number {
    return this.byChannelDbId.size;
  }

  /**
   * Graceful shutdown: закрывает все pinned WS-connection'ы (sends
   * close-frame 1001 "adapter closing") и дренирует waiters в receive().
   */
  closeAll(): void {
    for (const entry of this.byChannelDbId.values()) {
      entry.adapter.close();
    }
    this.byChannelDbId.clear();
    this.byTenantSlug.clear();
  }
}
