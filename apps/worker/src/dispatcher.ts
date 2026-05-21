import type { OutboundEnvelope } from "@chatman-media/channel-core";
import {
  type Db,
  OutboundQueueRepo,
  type OutboundQueueRow,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { PlatformMetrics } from "@chatman-media/observability";
import { tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import type { WorkerChannelRegistry } from "./channel-registry.ts";

/**
 * Outbound dispatcher: long-running loop, который:
 *   1. SELECT активных tenant_id из БД
 *   2. Для каждого — claim'ает до batchSize pending → processing (атомарно
 *      через UPDATE … FOR UPDATE SKIP LOCKED → status='processing'). Multi-
 *      worker safe: каждая row пойдёт ровно одному worker'у.
 *   3. Для каждой строки — резолвит ChannelAdapter и зовёт adapter.send.
 *   4. На успех → markSent с external_message_id; на ошибку → markFailed.
 *   5. Раз в `stuckCheckPeriod` tick'ов вызывает releaseStuckProcessing —
 *      возвращает зависшие processing rows (worker умер не вызвав mark*)
 *      обратно в pending для retry'я.
 */
export class OutboundDispatcher {
  private stopped = false;
  private ticksSinceStuckCheck = 0;

  constructor(
    private readonly db: Db,
    private readonly channels: WorkerChannelRegistry,
    private readonly opts: {
      pollMs: number;
      batchSize: number;
      /** Сколько секунд держать processing до auto-recovery. Default 300 (5 мин). */
      stuckProcessingSec?: number;
      /** Каждый N-й tick запускать releaseStuckProcessing. Default 60 (=1 минута при pollMs=1000). */
      stuckCheckPeriodTicks?: number;
      /** Опциональный PlatformMetrics для счётчиков outbound_sent/failed/latency. */
      metrics?: PlatformMetrics;
      /**
       * Whitelist channels.kind для claim'а. По умолчанию worker
       * обрабатывает push-channels (telegram_*, whatsapp). Web-канал
       * исключается, потому что у него адаптер живёт в apps/api с
       * pinned WebSocket-connection'ом — worker не сможет deliver и
       * mark'нет fail с reason="no_adapter".
       */
      claimKinds?: string[];
    },
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener("abort", () => {
      this.stopped = true;
    });

    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        console.error("[dispatcher] tick error", err);
      }
      await new Promise((r) => setTimeout(r, this.opts.pollMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * NB: каждый repo-вызов оборачивается в `withTenant(db, tenantId, ...)`,
   * который BEGIN-ит транзакцию и делает `SET LOCAL app.tenant_id = <id>`
   * — иначе на non-BYPASSRLS Postgres role'и (production setup, см.
   * миграцию 0004) policy `tenant_isolation` отрезала бы все UPDATE'ы
   * и SELECT'ы → dispatcher молча drain'ил бы 0 rows. `tenants` table
   * НЕ покрыт RLS-policy (см. comment в 0004), поэтому SELECT active
   * tenants работает без SET LOCAL.
   *
   * Важно: `adapter.send(envelope)` (HTTP / MTProto / WS) делается
   * ВНЕ транзакции — иначе мы держали бы Postgres-connection во время
   * slow external call'а и быстро упирались в pool exhaustion.
   */
  private async tick(): Promise<void> {
    const activeTenantIds = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.status, "active"));

    const now = Math.floor(Date.now() / 1000);
    const stuckCheckPeriod = this.opts.stuckCheckPeriodTicks ?? 60;
    const shouldCheckStuck = this.ticksSinceStuckCheck >= stuckCheckPeriod;
    if (shouldCheckStuck) this.ticksSinceStuckCheck = 0;
    else this.ticksSinceStuckCheck += 1;

    for (const t of activeTenantIds) {
      if (shouldCheckStuck) {
        const released = await withTenant(this.db, t.id, async (tx) => {
          const txRepo = new OutboundQueueRepo({ db: tx, tenantId: t.id });
          return txRepo.releaseStuckProcessing({
            nowEpoch: now,
            stuckSec: this.opts.stuckProcessingSec ?? 300,
          });
        });
        if (released > 0) {
          console.log(
            `[dispatcher] released ${released} stuck processing rows for tenant=${t.id}`,
          );
        }
      }

      const claimed = await withTenant(this.db, t.id, async (tx) => {
        const txRepo = new OutboundQueueRepo({ db: tx, tenantId: t.id });
        return txRepo.claimPending({
          limit: this.opts.batchSize,
          nowEpoch: now,
          ...(this.opts.claimKinds && this.opts.claimKinds.length > 0
            ? { kinds: this.opts.claimKinds }
            : {}),
        });
      });
      for (const row of claimed) {
        await this.deliverOne(row);
      }
    }
  }

  private async deliverOne(row: OutboundQueueRow): Promise<void> {
    const tenantLabel = { tenant: String(row.tenantId) };
    const entry = this.channels.byChannelId(row.channelId);
    if (!entry) {
      await this.markFailed(row, `no active adapter for channel_id=${row.channelId}`);
      this.opts.metrics?.outboundFailed.inc(1, { ...tenantLabel, reason: "no_adapter" });
      return;
    }
    let envelope: OutboundEnvelope;
    try {
      envelope = JSON.parse(row.payloadJson) as OutboundEnvelope;
    } catch (err) {
      await this.markFailed(row, `invalid payload_json: ${err}`);
      this.opts.metrics?.outboundFailed.inc(1, { ...tenantLabel, reason: "bad_payload" });
      return;
    }
    const startedAt = performance.now();
    try {
      // Внешний send ВНЕ tx — иначе HTTP/MTProto latency держала бы
      // pool connection (см. doc-comment к tick()).
      const sent = await entry.adapter.send(envelope);
      const sentAt = Math.floor(Date.now() / 1000);
      await withTenant(this.db, row.tenantId, async (tx) => {
        const txRepo = new OutboundQueueRepo({ db: tx, tenantId: row.tenantId });
        await txRepo.markSent(row.id, sent.externalMessageId, sentAt);
      });
      const dispatchLag = sentAt - row.createdAt;
      this.opts.metrics?.outboundSent.inc(1, { ...tenantLabel, kind: entry.kind });
      this.opts.metrics?.outboundDispatchLatency.observe(
        Math.max(dispatchLag, (performance.now() - startedAt) / 1000),
        tenantLabel,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markFailed(row, msg);
      this.opts.metrics?.outboundFailed.inc(1, { ...tenantLabel, reason: "send_error" });
    }
  }

  private async markFailed(row: OutboundQueueRow, error: string): Promise<void> {
    await withTenant(this.db, row.tenantId, async (tx) => {
      const txRepo = new OutboundQueueRepo({ db: tx, tenantId: row.tenantId });
      await txRepo.markFailed(row.id, error);
    });
  }
}
