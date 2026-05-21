import type { OutboundEnvelope } from "@chatman-media/channel-core";
import { channels, outboundQueue } from "@chatman-media/storage";
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
  /**
   * @param opts.kinds  Опциональный whitelist `channels.kind` для claim'а.
   *   Когда задан, JOIN'имся с `channels` и берём только rows для каналов
   *   указанных типов. Используется чтобы worker не claim'ил web-rows
   *   (адаптер web-канала живёт в apps/api in-memory с WS-connection'ом —
   *   worker до него не достанется и mark'нет fail спустя no_adapter).
   *   undefined → не фильтруем (legacy / тесты).
   */
  async claimPending(opts: {
    limit: number;
    nowEpoch: number;
    kinds?: string[];
  }): Promise<OutboundQueueRow[]> {
    // db.execute(sql`...`) с postgres-js возвращает snake_case columns —
    // в отличие от drizzle's .select() / .update().returning() которые
    // мапят на camelCase через schema. Map'им вручную чтобы остальной
    // dispatcher code мог обращаться к row.channelId / row.tenantId.
    const kindFilter =
      opts.kinds && opts.kinds.length > 0
        ? sql`AND ${outboundQueue.channelId} IN (
            SELECT id FROM ${channels} WHERE ${channels.kind} IN (${sql.join(
              opts.kinds.map((k) => sql`${k}`),
              sql`, `,
            )})
          )`
        : sql``;
    const raw = (await this.ctx.db.execute(sql`
      UPDATE ${outboundQueue}
      SET status = 'processing'
      WHERE id IN (
        SELECT id FROM ${outboundQueue}
        WHERE tenant_id = ${this.ctx.tenantId}
          AND status = 'pending'
          AND scheduled_at <= ${opts.nowEpoch}
          ${kindFilter}
        ORDER BY scheduled_at ASC
        LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `)) as unknown as Array<Record<string, unknown>>;
    return raw.map(
      (r): OutboundQueueRow => ({
        id: r.id as number,
        tenantId: r.tenant_id as number,
        channelId: r.channel_id as number,
        conversationId: (r.conversation_id ?? null) as number | null,
        payloadJson: r.payload_json as string,
        idempotencyKey: (r.idempotency_key ?? null) as string | null,
        scheduledAt: r.scheduled_at as number,
        status: r.status as OutboundQueueRow["status"],
        attempt: r.attempt as number,
        lastError: (r.last_error ?? null) as string | null,
        externalMessageId: (r.external_message_id ?? null) as string | null,
        sentAt: (r.sent_at ?? null) as number | null,
        createdAt: r.created_at as number,
      }),
    );
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
