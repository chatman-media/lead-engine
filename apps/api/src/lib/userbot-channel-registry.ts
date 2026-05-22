import { TelegramUserbotAdapter } from "@chatman-media/channel-telegram";
import {
  type Db,
  getDecryptedSecret,
  setEncryptedSecret,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { JsonLogger } from "@chatman-media/observability";
import { channels, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";

/**
 * Registry для in-process `TelegramUserbotAdapter`'ов в apps/api. Один adapter
 * на `channels.id` (kind='telegram_userbot', status='active').
 *
 * Как и WebChannelRegistry, userbot держит pinned MTProto-соединение и живёт
 * в apps/api (НЕ в worker'е — у persistent-соединения inbound и outbound идут
 * через один и тот же gramjs-client). Registry владеет жизненным циклом:
 * connect adapter → стартует inbound-runner (через инжектируемую фабрику) →
 * на удаление/смену сессии останавливает runner + disconnect.
 *
 * reloadTenant сверяет по (channelId, updatedAt): здоровые неизменные
 * соединения НЕ пересоздаёт (избегаем MTProto-relogin churn'а), но re-auth
 * (updatedAt bump) → reconnect с новой сессией.
 */
export interface UserbotChannelEntry {
  channelDbId: number;
  tenantId: number;
  tenantSlug: string;
  externalId: string;
  adapter: TelegramUserbotAdapter;
}

/** Стартует inbound-pipeline + health-watch для подключённого entry. */
export type UserbotRunnerFactory = (
  entry: UserbotChannelEntry,
  signal: AbortSignal,
) => Promise<void>;

interface ManagedEntry {
  entry: UserbotChannelEntry;
  updatedAt: number;
  abort: AbortController;
  runner: Promise<void>;
}

export interface UserbotChannelRegistryOpts {
  apiId: number;
  apiHash: string;
  masterKeyHex: string;
  log: JsonLogger;
}

export class UserbotChannelRegistry {
  private readonly byChannelDbId = new Map<number, ManagedEntry>();
  private dbRef: Db | null = null;
  private runnerFactory: UserbotRunnerFactory | null = null;

  constructor(private readonly opts: UserbotChannelRegistryOpts) {}

  /** Должна быть вызвана до loadFromDb — иначе entries загрузятся без inbound-обработки. */
  setRunnerFactory(factory: UserbotRunnerFactory): void {
    this.runnerFactory = factory;
  }

  async loadFromDb(db: Db): Promise<void> {
    this.dbRef = db;
    const rows = await this.queryRows();
    for (const row of rows) {
      await this.connectEntry(row);
    }
  }

  private queryRows(tenantId?: number) {
    if (!this.dbRef) throw new Error("UserbotChannelRegistry: db not set");
    const where = tenantId
      ? and(
          eq(channels.tenantId, tenantId),
          eq(channels.kind, "telegram_userbot"),
          eq(channels.status, "active"),
          eq(tenants.status, "active"),
        )
      : and(
          eq(channels.kind, "telegram_userbot"),
          eq(channels.status, "active"),
          eq(tenants.status, "active"),
        );
    return this.dbRef
      .select({
        channelId: channels.id,
        externalId: channels.externalId,
        credentialsRef: channels.credentialsRef,
        updatedAt: channels.updatedAt,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
      })
      .from(channels)
      .innerJoin(tenants, eq(tenants.id, channels.tenantId))
      .where(where);
  }

  private async connectEntry(row: {
    channelId: number;
    externalId: string;
    credentialsRef: string | null;
    updatedAt: number;
    tenantId: number;
    tenantSlug: string;
  }): Promise<void> {
    if (this.opts.apiId === 0 || !this.opts.apiHash) return;
    if (!row.credentialsRef) {
      this.opts.log.warn("userbot channel has no credentialsRef — skipping", {
        channelId: row.channelId,
        tenantId: row.tenantId,
      });
      return;
    }
    let sessionString = "";
    try {
      sessionString =
        (await getDecryptedSecret({
          db: this.dbRef as Db,
          tenantId: row.tenantId,
          key: row.credentialsRef,
          masterKeyHex: this.opts.masterKeyHex,
        })) ?? "";
    } catch (err) {
      this.opts.log.warn("failed to decrypt userbot session", {
        channelId: row.channelId,
        tenantId: row.tenantId,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!sessionString) {
      this.opts.log.warn("userbot session empty — needs re-auth", {
        channelId: row.channelId,
        tenantId: row.tenantId,
      });
      return;
    }

    const credentialsRef = row.credentialsRef;
    const adapter = new TelegramUserbotAdapter({
      id: String(row.channelId),
      apiId: this.opts.apiId,
      apiHash: this.opts.apiHash,
      sessionString,
      // gramjs может выдать обновлённую session на reconnect — пере-шифруем.
      onSessionUpdated: async (updated) => {
        try {
          await setEncryptedSecret({
            db: this.dbRef as Db,
            tenantId: row.tenantId,
            key: credentialsRef,
            value: updated,
            masterKeyHex: this.opts.masterKeyHex,
            nowEpoch: Math.floor(Date.now() / 1000),
          });
        } catch (err) {
          this.opts.log.warn("failed to persist rotated userbot session", {
            channelId: row.channelId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    try {
      await adapter.connect();
    } catch (err) {
      // Сессия отозвана / сеть — помечаем канал error, чтобы UI предложил
      // повторную авторизацию. Не валим boot.
      this.opts.log.warn("userbot connect failed", {
        channelId: row.channelId,
        tenantId: row.tenantId,
        err: err instanceof Error ? err.message : String(err),
      });
      await this.markChannelError(row.tenantId, row.channelId);
      try {
        await adapter.close();
      } catch {
        // ignore
      }
      return;
    }

    const entry: UserbotChannelEntry = {
      channelDbId: row.channelId,
      tenantId: row.tenantId,
      tenantSlug: row.tenantSlug,
      externalId: row.externalId,
      adapter,
    };
    const abort = new AbortController();
    const runner = this.runnerFactory ? this.runnerFactory(entry, abort.signal) : Promise.resolve();
    this.byChannelDbId.set(row.channelId, {
      entry,
      updatedAt: row.updatedAt,
      abort,
      runner,
    });
    this.opts.log.info("userbot connected", {
      channelId: row.channelId,
      tenantId: row.tenantId,
      externalId: row.externalId,
    });
  }

  private async markChannelError(tenantId: number, channelId: number): Promise<void> {
    if (!this.dbRef) return;
    try {
      await withTenant(this.dbRef, tenantId, async (tx) => {
        await tx
          .update(channels)
          .set({ status: "error", updatedAt: Math.floor(Date.now() / 1000) })
          .where(and(eq(channels.id, channelId), eq(channels.tenantId, tenantId)));
      });
    } catch {
      // best-effort
    }
  }

  /**
   * Hot-reload userbot'ов одного тенанта. Сверяем по (channelId, updatedAt):
   *  - row отсутствует в fresh → закрыть.
   *  - новый channelId или updatedAt изменился (re-auth) → (закрыть старый) + connect.
   *  - тот же channelId + updatedAt → не трогаем (без relogin churn'а).
   */
  async reloadTenant(tenantId: number, _tenantSlug: string): Promise<void> {
    if (!this.dbRef) return;
    const rows = await this.queryRows(tenantId);
    const freshById = new Map(rows.map((r) => [r.channelId, r]));

    // Закрыть пропавшие из fresh (для этого тенанта).
    for (const [chId, managed] of [...this.byChannelDbId]) {
      if (managed.entry.tenantId !== tenantId) continue;
      const fresh = freshById.get(chId);
      if (!fresh || fresh.updatedAt !== managed.updatedAt) {
        await this.closeEntry(chId);
      }
    }
    // Подключить новые / изменённые.
    for (const row of rows) {
      if (!this.byChannelDbId.has(row.channelId)) {
        await this.connectEntry(row);
      }
    }
  }

  private async closeEntry(channelDbId: number): Promise<void> {
    const managed = this.byChannelDbId.get(channelDbId);
    if (!managed) return;
    this.byChannelDbId.delete(channelDbId);
    managed.abort.abort();
    try {
      await managed.entry.adapter.close();
    } catch {
      // ignore
    }
  }

  byChannelId(channelDbId: number): UserbotChannelEntry | undefined {
    return this.byChannelDbId.get(channelDbId)?.entry;
  }

  byTenant(tenantId: number): UserbotChannelEntry[] {
    return [...this.byChannelDbId.values()]
      .filter((m) => m.entry.tenantId === tenantId)
      .map((m) => m.entry);
  }

  entries(): UserbotChannelEntry[] {
    return [...this.byChannelDbId.values()].map((m) => m.entry);
  }

  size(): number {
    return this.byChannelDbId.size;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.byChannelDbId.keys()].map((id) => this.closeEntry(id)));
  }
}
