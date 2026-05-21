import type { Inbound, OutboundEnvelope } from "@chatman-media/channel-core";
import { OutboundQueueRepo } from "./dal/outbound.ts";
import type { Db } from "./dal/types.ts";
import { dispatchOutbound } from "./outbound-dispatch.ts";
import { type ReplyStrategy } from "./process-inbound.ts";
import { systemClock } from "./types.ts";
import type { ChannelContext, PipelineSink, ProcessInboundResult, TenantContext } from "./types.ts";
import { withTenant } from "./with-tenant.ts";

/**
 * Phase 2 of split pipeline (см. `processInbound` doc по `deferReply`):
 * вызывает `reply.generate` ВНЕ открытой Postgres-tx и затем открывает
 * собственную короткую tx через withTenant для enqueue outbound rows.
 *
 * Это разделение освобождает Postgres pool connection на время LLM
 * call'а (~1-2s) — критично для high-throughput inbound на ограниченном
 * pool=10.
 *
 * Caller-pattern:
 *   const result = await withTenant(db, tenantId, (tx) =>
 *     processInbound(inbound, { ..., db: tx, deferReply: true })
 *   );
 *   if (result.replyDeferred && replyStrategy) {
 *     await generateReplyAndEnqueue({
 *       db, tenantId, channelDbId, channel, tenant,
 *       inbound, result, replyStrategy, sink,
 *     });
 *   }
 *
 * Когда `result.replyDeferred` is false/undefined — caller не должен
 * вызывать эту функцию (processInbound уже отработал полностью single-tx).
 */
export interface GenerateReplyAndEnqueueDeps {
  db: Db;
  tenant: TenantContext;
  channel: ChannelContext;
  channelDbId: number;
  inbound: Inbound;
  /** Результат processInbound с deferReply=true. */
  result: ProcessInboundResult;
  replyStrategy: ReplyStrategy;
  sink?: PipelineSink;
  clock?: { nowEpoch: () => number };
}

export interface GenerateReplyResult {
  /** Кол-во envelope'ов поставлено в outbound_queue. 0 если reply пустой
   *  или mediaOnly или conversation.mode != 'ai' (но проверка mode не
   *  делается тут — caller сам решает по результату processInbound). */
  outboundEnqueued: number;
}

export async function generateReplyAndEnqueue(
  deps: GenerateReplyAndEnqueueDeps,
): Promise<GenerateReplyResult> {
  const clock = deps.clock ?? systemClock;
  const { result, replyStrategy, inbound, tenant, channel, channelDbId } = deps;

  // Если pipeline пометил mediaOnly — reply не генерируем (бот не отвечает
  // на чистые media без caption).
  if (result.mediaOnly) {
    return { outboundEnqueued: 0 };
  }

  // userMessageText заполняется processInbound'ом при deferReply=true.
  // Если undefined — caller ошибся в orchestration'е; возвращаем 0.
  const text = result.userMessageText ?? "";
  if (text.length === 0) return { outboundEnqueued: 0 };

  // ── Phase 2A: LLM call ВНЕ tx ────────────────────────────────────────
  const envelopes = await replyStrategy.generate({
    tenant,
    channel,
    conversationId: result.conversationId,
    contactId: result.contactId,
    inbound,
    userMessageText: text,
  });
  if (!envelopes || envelopes.length === 0) {
    return { outboundEnqueued: 0 };
  }

  // ── Phase 2B: enqueue в новой короткой tx ────────────────────────────
  const now = clock.nowEpoch();
  let count = 0;
  await withTenant(deps.db, tenant.tenantId, async (tx) => {
    const outbound = new OutboundQueueRepo({ db: tx, tenantId: tenant.tenantId });
    for (const env of envelopes as OutboundEnvelope[]) {
      const queued = await dispatchOutbound({
        channelDbId,
        conversationId: result.conversationId,
        envelope: env,
        outbound,
        nowEpoch: now,
      });
      count += 1;
      deps.sink?.emit?.({
        type: "outbound-enqueued",
        tenantId: tenant.tenantId,
        conversationId: result.conversationId,
        queueItemId: queued.id,
        envelope: env,
      });
    }
  });
  return { outboundEnqueued: count };
}
