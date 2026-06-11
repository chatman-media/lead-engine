import type { Inbound, OutboundEnvelope } from "@chatman-media/channel-core";
import { ConversationsRepo } from "./dal/conversations.ts";
import { MessagesRepo } from "./dal/messages.ts";
import { OutboundQueueRepo } from "./dal/outbound.ts";
import type { Db } from "./dal/types.ts";
import { dispatchOutbound } from "./outbound-dispatch.ts";
import { normalizeReplyStrategyResult, type ReplyStrategy } from "./process-inbound.ts";
import type { NotificationService } from "./notifications.ts";
import {
  emitOperatorHandoffNotifications,
  primaryOperatorHandoff,
} from "./operator-handoff.ts";
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
 *     processInbound(inbound, { ..., deferReply: true, deferPostProcessing: true })
 *   );
 *   await runDeferredInboundPostProcessing({
 *     db, tenant, result, stageClassifier, memoryExtractor, sink,
 *   });
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
  notifications?: NotificationService | null;
  sink?: PipelineSink;
  clock?: { nowEpoch: () => number };
}

export interface GenerateReplyResult {
  /** Кол-во envelope'ов поставлено в outbound_queue. 0 если reply пустой
   *  или mediaOnly или conversation.mode != 'ai' (но проверка mode не
   *  делается тут — caller сам решает по результату processInbound). */
  outboundEnqueued: number;
  escalatedReason?: string;
}

function envelopeText(envelope: OutboundEnvelope): string | null {
  const text = envelope.parts
    .map((part) => {
      if (part.kind === "text") return part.text;
      return part.caption ?? "";
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  return text || null;
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
  if (result.escalatedReason) {
    return { outboundEnqueued: 0, escalatedReason: result.escalatedReason };
  }

  // userMessageText заполняется processInbound'ом при deferReply=true.
  // Если undefined — caller ошибся в orchestration'е; возвращаем 0.
  const text = result.userMessageText ?? "";
  if (text.length === 0) return { outboundEnqueued: 0 };

  // ── Phase 2A: LLM call ВНЕ tx ────────────────────────────────────────
  const replyOutput = normalizeReplyStrategyResult(
    await replyStrategy.generate({
      tenant,
      channel,
      conversationId: result.conversationId,
      contactId: result.contactId,
      inbound,
      userMessageText: text,
    }),
  );
  if (!replyOutput) {
    return { outboundEnqueued: 0 };
  }
  const needsAutoTakeover =
    replyOutput.autoTakeover && (replyOutput.operatorHandoffs?.length ?? 0) > 0;
  if (replyOutput.envelopes.length === 0 && !needsAutoTakeover) {
    return { outboundEnqueued: 0 };
  }

  // ── Phase 2B: enqueue в новой короткой tx ────────────────────────────
  const now = clock.nowEpoch();
  let count = 0;
  let escalatedReason: string | undefined;
  await withTenant(deps.db, tenant.tenantId, async (tx) => {
    const repoCtx = { db: tx, tenantId: tenant.tenantId };
    const conversations = new ConversationsRepo(repoCtx);
    const messages = new MessagesRepo(repoCtx);
    const outbound = new OutboundQueueRepo({ db: tx, tenantId: tenant.tenantId });
    for (const env of replyOutput.envelopes as OutboundEnvelope[]) {
      const aiText = envelopeText(env);
      if (aiText) {
        const inserted = await messages.insert({
          conversationId: result.conversationId,
          role: "assistant",
          text: aiText,
          nowEpoch: now,
        });
        deps.sink?.emit?.({
          type: "message-persisted",
          tenantId: tenant.tenantId,
          conversationId: result.conversationId,
          messageId: inserted.id,
          role: "assistant",
        });
        await conversations.updateInboxMetadata(result.conversationId, {
          lastMessageAt: now,
          lastMessageText: aiText.slice(0, 200),
        });
      }
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
    if (needsAutoTakeover) {
      const handoff = primaryOperatorHandoff(replyOutput.operatorHandoffs);
      if (handoff) {
        await conversations.applyAutoHandoff({
          conversationId: result.conversationId,
          reason: handoff.reason,
          ...(handoff.orderId !== undefined ? { orderId: handoff.orderId } : {}),
          ...(handoff.stageSlug ? { stageSlug: handoff.stageSlug } : {}),
          customerNoticeSent: replyOutput.customerNoticeSent === true,
          nowEpoch: now,
        });
        escalatedReason = handoff.reason;
      }
    }
  });
  await emitOperatorHandoffNotifications({
    tenantId: tenant.tenantId,
    conversationId: result.conversationId,
    contactId: result.contactId,
    contactDisplayName: result.contactDisplayName,
    userMessageText: text,
    inbound,
    envelopes: replyOutput.envelopes,
    ...(replyOutput.operatorHandoffs
      ? { operatorHandoffs: replyOutput.operatorHandoffs }
      : {}),
    notifications: deps.notifications ?? null,
    ...(deps.sink ? { sink: deps.sink } : {}),
  });
  return {
    outboundEnqueued: count,
    ...(escalatedReason ? { escalatedReason } : {}),
  };
}
