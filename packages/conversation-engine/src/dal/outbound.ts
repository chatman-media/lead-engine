import type { OutboundEnvelope } from "@chatman-media/channel-core";
import { outboundQueue } from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface OutboundQueueRow {
  id: number;
  tenantId: number;
  channelId: number;
  conversationId: number | null;
  payloadJson: string;
  idempotencyKey: string | null;
  scheduledAt: number;
  status: "pending" | "processing" | "sent" | "failed" | "cancelled";
  attempt: number;
  lastError: string | null;
  externalMessageId: string | null;
  sentAt: number | null;
  createdAt: number;
}

export class OutboundQueueRepo {
  constructor(private readonly ctx: RepoCtx) {}

  /**
   * Поставить envelope в очередь. Идемпотентный insert через
   * idempotency_key — если строка уже существует, возвращается имеющаяся
   * вместо дубля. Это защищает от retry'я process-inbound'а после краша
   * worker'а (Telegram повторно постит webhook).
   */
  async enqueue(opts: {
    channelId: number;
    conversationId?: number | null;
    envelope: OutboundEnvelope;
    scheduledAt?: number;
    nowEpoch: number;
  }): Promise<OutboundQueueRow> {
    const payload = JSON.stringify(opts.envelope);
    const key = opts.envelope.idempotencyKey ?? null;

    if (key !== null) {
      const [existing] = await this.ctx.db
        .select()
        .from(outboundQueue)
        .where(
          and(
            eq(outboundQueue.tenantId, this.ctx.tenantId),
            eq(outboundQueue.idempotencyKey, key),
          ),
        );
      if (existing) return existing as OutboundQueueRow;
    }

    const [row] = await this.ctx.db
      .insert(outboundQueue)
      .values({
        tenantId: this.ctx.tenantId,
        channelId: opts.channelId,
        ...(opts.conversationId !== undefined && opts.conversationId !== null
          ? { conversationId: opts.conversationId }
          : {}),
        payloadJson: payload,
        ...(key ? { idempotencyKey: key } : {}),
        scheduledAt: opts.scheduledAt ?? opts.nowEpoch,
        createdAt: opts.nowEpoch,
      })
      .returning();
    if (!row) throw new Error("outbound_queue.enqueue: insert returned no row");
    return row as OutboundQueueRow;
  }

  /**
   * Атомарно claim'ает до `limit` pending envelope'ов: UPDATE'ом переводит
   * их в status='processing' и returning'ом отдаёт worker'у. Использует
   * `FOR UPDATE SKIP LOCKED` в inner SELECT — multi-worker safe: каждая
   * row claim'ается ровно одним worker'ом, остальные пропускают её
   * без блокировки.
   *
   * Worker'у обязательно вызвать markSent или markFailed после processing —
   * row застрянет в processing иначе. Cleanup-cron для возврата
   * processing→pending после timeout'а — отдельный job в Issue #3 / M-2.
   */
  async claimPending(opts: { limit: number; nowEpoch: number }): Promise<OutboundQueueRow[]> {
    const rows = await this.ctx.db.execute(sql`
      UPDATE ${outboundQueue}
      SET status = 'processing'
      WHERE id IN (
        SELECT id FROM ${outboundQueue}
        WHERE tenant_id = ${this.ctx.tenantId}
          AND status = 'pending'
          AND scheduled_at <= ${opts.nowEpoch}
        ORDER BY scheduled_at ASC
        LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    return rows as unknown as OutboundQueueRow[];
  }

  /**
   * Откатить зависшие processing rows обратно в pending. Идёт по rows
   * у которых status='processing' дольше `stuckSec` секунд (worker умер
   * не дойдя до markSent/markFailed). Cron'ится из apps/worker раз в N минут.
   */
  async releaseStuckProcessing(opts: {
    nowEpoch: number;
    stuckSec: number;
  }): Promise<number> {
    const cutoff = opts.nowEpoch - opts.stuckSec;
    const rows = await this.ctx.db.execute(sql`
      UPDATE ${outboundQueue}
      SET status = 'pending'
      WHERE tenant_id = ${this.ctx.tenantId}
        AND status = 'processing'
        AND scheduled_at < ${cutoff}
      RETURNING id
    `);
    return Array.isArray(rows) ? rows.length : 0;
  }

  async markSent(id: number, externalMessageId: string, nowEpoch: number): Promise<void> {
    await this.ctx.db
      .update(outboundQueue)
      .set({
        status: "sent",
        externalMessageId,
        sentAt: nowEpoch,
        attempt: sql`${outboundQueue.attempt} + 1`,
      })
      .where(
        and(eq(outboundQueue.id, id), eq(outboundQueue.tenantId, this.ctx.tenantId)),
      );
  }

  async markFailed(id: number, error: string): Promise<void> {
    await this.ctx.db
      .update(outboundQueue)
      .set({
        status: "failed",
        lastError: error,
        attempt: sql`${outboundQueue.attempt} + 1`,
      })
      .where(
        and(eq(outboundQueue.id, id), eq(outboundQueue.tenantId, this.ctx.tenantId)),
      );
  }
}
