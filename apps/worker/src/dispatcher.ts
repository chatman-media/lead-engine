import type { OutboundEnvelope } from "@chatman-media/channel-core";
import {
  type Db,
  OutboundQueueRepo,
  type OutboundQueueRow,
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
      const repo = new OutboundQueueRepo({ db: this.db, tenantId: t.id });

      if (shouldCheckStuck) {
        const released = await repo.releaseStuckProcessing({
          nowEpoch: now,
          stuckSec: this.opts.stuckProcessingSec ?? 300,
        });
        if (released > 0) {
          console.log(
            `[dispatcher] released ${released} stuck processing rows for tenant=${t.id}`,
          );
        }
      }

      const claimed = await repo.claimPending({
        limit: this.opts.batchSize,
        nowEpoch: now,
      });
      for (const row of claimed) {
        await this.deliverOne(repo, row);
      }
    }
  }

  private async deliverOne(repo: OutboundQueueRepo, row: OutboundQueueRow): Promise<void> {
    const tenantLabel = { tenant: String(row.tenantId) };
    const entry = this.channels.byChannelId(row.channelId);
    if (!entry) {
      await repo.markFailed(row.id, `no active adapter for channel_id=${row.channelId}`);
      this.opts.metrics?.outboundFailed.inc(1, { ...tenantLabel, reason: "no_adapter" });
      return;
    }
    let envelope: OutboundEnvelope;
    try {
      envelope = JSON.parse(row.payloadJson) as OutboundEnvelope;
    } catch (err) {
      await repo.markFailed(row.id, `invalid payload_json: ${err}`);
      this.opts.metrics?.outboundFailed.inc(1, { ...tenantLabel, reason: "bad_payload" });
      return;
    }
    const startedAt = performance.now();
    try {
      const sent = await entry.adapter.send(envelope);
      const sentAt = Math.floor(Date.now() / 1000);
      await repo.markSent(row.id, sent.externalMessageId, sentAt);
      const dispatchLag = sentAt - row.createdAt;
      this.opts.metrics?.outboundSent.inc(1, { ...tenantLabel, kind: entry.kind });
      this.opts.metrics?.outboundDispatchLatency.observe(
        Math.max(dispatchLag, (performance.now() - startedAt) / 1000),
        tenantLabel,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await repo.markFailed(row.id, msg);
      this.opts.metrics?.outboundFailed.inc(1, { ...tenantLabel, reason: "send_error" });
    }
  }
}
