import type { OutboundEnvelope } from "@chatman-media/channel-core";
import { outboundQueue } from "@chatman-media/storage";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface OutboundQueueRow {
  id: number;
  tenantId: number;
  channelId: number;
  conversationId: number | null;
  payloadJson: string;
  idempotencyKey: string | null;
  scheduledAt: number;
  status: "pending" | "sent" | "failed" | "cancelled";
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
   * Pop'нуть pending envelope'ы для worker'а. Сортирует по scheduled_at,
   * лимитирует. Worker сам помечает их status='sent'/'failed' после
   * фактической отправки через ChannelAdapter.
   */
  async claimPending(opts: { limit: number; nowEpoch: number }): Promise<OutboundQueueRow[]> {
    const rows = await this.ctx.db
      .select()
      .from(outboundQueue)
      .where(
        and(
          eq(outboundQueue.tenantId, this.ctx.tenantId),
          eq(outboundQueue.status, "pending"),
          lte(outboundQueue.scheduledAt, opts.nowEpoch),
        ),
      )
      .orderBy(asc(outboundQueue.scheduledAt))
      .limit(opts.limit);
    return rows as OutboundQueueRow[];
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
