import type { OutboundEnvelope } from "@chatman-media/channel-core";
import {
  type Db,
  OutboundQueueRepo,
  type OutboundQueueRow,
} from "@chatman-media/conversation-engine";
import { tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import type { WorkerChannelRegistry } from "./channel-registry.ts";

/**
 * Outbound dispatcher: long-running loop, который:
 *   1. SELECT'ит активные tenant_id из БД
 *   2. Для каждого — pop'ает pending outbound_queue (claimPending)
 *   3. Для каждой строки — резолвит ChannelAdapter и зовёт adapter.send(envelope)
 *   4. Маркирует строку как 'sent' (с external_message_id) или 'failed'
 *      (с error и инкрементом attempt)
 *
 * Не использует SELECT FOR UPDATE — claim-then-mark стратегия. На одиночном
 * worker'е достаточно. Для horizontal scaling в Этапе 9+ заменим на advisory
 * lock или транзакционный SKIP LOCKED.
 */
export class OutboundDispatcher {
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly channels: WorkerChannelRegistry,
    private readonly opts: {
      pollMs: number;
      batchSize: number;
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
    for (const t of activeTenantIds) {
      const repo = new OutboundQueueRepo({ db: this.db, tenantId: t.id });
      const pending = await repo.claimPending({
        limit: this.opts.batchSize,
        nowEpoch: now,
      });
      for (const row of pending) {
        await this.deliverOne(repo, row);
      }
    }
  }

  private async deliverOne(repo: OutboundQueueRepo, row: OutboundQueueRow): Promise<void> {
    const entry = this.channels.byChannelId(row.channelId);
    if (!entry) {
      await repo.markFailed(row.id, `no active adapter for channel_id=${row.channelId}`);
      return;
    }
    let envelope: OutboundEnvelope;
    try {
      envelope = JSON.parse(row.payloadJson) as OutboundEnvelope;
    } catch (err) {
      await repo.markFailed(row.id, `invalid payload_json: ${err}`);
      return;
    }
    try {
      const sent = await entry.adapter.send(envelope);
      await repo.markSent(row.id, sent.externalMessageId, Math.floor(Date.now() / 1000));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await repo.markFailed(row.id, msg);
    }
  }
}
