import type { Inbound, InboundPart } from "@chatman-media/channel-core";
import { channels as channelsTable } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { ChannelIdentitiesRepo } from "./dal/channel-identities.ts";
import { ContactsRepo } from "./dal/contacts.ts";
import { MessagesRepo } from "./dal/messages.ts";
import type { Db } from "./dal/types.ts";
import { generateReplyAndEnqueue } from "./dispatch-reply.ts";
import type { ReplyStrategy } from "./process-inbound.ts";
import type { NotificationService } from "./notifications.ts";
import { systemClock } from "./types.ts";
import type {
  ChannelContext,
  PipelineSink,
  ProcessInboundResult,
  TenantContext,
} from "./types.ts";
import { startTypingKeepalive } from "./typing-keepalive.ts";
import { withTenant } from "./with-tenant.ts";

/**
 * Claimed-строка из ConversationsRepo.claimDueReplies — минимум, который
 * поллер знает о диалоге с наступившим дедлайном отложенного ответа.
 */
export interface DueConversation {
  id: number;
  /** contact.id (legacy-имя колонки user_id). */
  userId: number;
  channelId: number | null;
  mode: "ai" | "queued" | "human";
  currentStage: string | null;
}

export interface GenerateReplyForConversationDeps {
  db: Db;
  tenant: TenantContext;
  conversation: DueConversation;
  replyStrategy: ReplyStrategy;
  notifications?: NotificationService | null;
  sink?: PipelineSink;
  clock?: { nowEpoch: () => number };
  /** #628 — дробить длинный ответ на несколько сообщений (из botSettings). */
  splitReplies?: boolean;
  /** #630 — кастомный текст фолбэка (из botSettings). */
  fallbackText?: string | null;
  /** #627 — порог серии фолбэков для передачи оператору (из botSettings). */
  handoffAfterFallbacks?: number | null;
  /**
   * #628 — индикатор «печатает…» для отложенного ответа: резолвер шлёт typing
   * в канал по (channelDbId, externalUserId). Инжектится из apps/api, где есть
   * ChannelRegistry. null/undefined — индикатор не шлём.
   */
  signalTyping?: ((channelDbId: number, externalUserId: string) => Promise<void>) | null;
}

function partsFromMetaJson(metaJson: string | null, fallbackText: string): InboundPart[] {
  if (metaJson) {
    try {
      const parsed = JSON.parse(metaJson) as { parts?: unknown };
      if (Array.isArray(parsed.parts) && parsed.parts.length > 0) {
        return parsed.parts as InboundPart[];
      }
    } catch {
      // Битый metaJson не должен ломать отложенный ответ — падаем на text.
    }
  }
  return [{ kind: "text", text: fallbackText }];
}

/**
 * Генерирует отложенный ответ для диалога по одному `conversationId` —
 * восстанавливая контекст из БД (канал, получатель, последнее user-сообщение).
 * Вызывается debounce-поллером (apps/api) для строк, claimed'ленных
 * `ConversationsRepo.claimDueReplies`.
 *
 * Дебаунсится только генерация: история к этому моменту полностью персистнута
 * (каждое сообщение окна прошло processInbound Phase 1), поэтому стратегия
 * читает её через `messages.recent()` и отвечает один раз на всю переписку.
 *
 * Переиспользует `generateReplyAndEnqueue` (LLM вне tx + enqueue в короткой tx),
 * собирая синтетические Inbound + ProcessInboundResult из БД.
 */
export async function generateReplyForConversation(
  deps: GenerateReplyForConversationDeps,
): Promise<{ outboundEnqueued: number }> {
  const { conversation } = deps;
  // Диалог ушёл к оператору (или нет канала) — отложенный AI-ответ не нужен.
  if (conversation.mode !== "ai" || conversation.channelId === null) {
    return { outboundEnqueued: 0 };
  }
  const channelId = conversation.channelId;

  // Короткая read-tx: восстановить канал/получателя/последнее сообщение.
  const ctx = await withTenant(deps.db, deps.tenant.tenantId, async (tx) => {
    const repoCtx = { db: tx, tenantId: deps.tenant.tenantId };
    const [channelRow] = await tx
      .select({ kind: channelsTable.kind, externalId: channelsTable.externalId })
      .from(channelsTable)
      .where(
        and(eq(channelsTable.id, channelId), eq(channelsTable.tenantId, deps.tenant.tenantId)),
      );
    const identity = await new ChannelIdentitiesRepo(repoCtx).findByContact(
      conversation.userId,
      channelId,
    );
    const latest = await new MessagesRepo(repoCtx).latestUser(conversation.id);
    const contact = await new ContactsRepo(repoCtx).byId(conversation.userId);
    return { channelRow, identity, latest, contact };
  });

  // Без канала / идентичности / текста последнего сообщения — отвечать нечем
  // (media-only последнее сообщение обрабатывает оператор). Тихо выходим.
  if (!ctx.channelRow || !ctx.identity || !ctx.latest) return { outboundEnqueued: 0 };
  const text = ctx.latest.text.trim();
  if (text.length === 0) return { outboundEnqueued: 0 };
  const recipientExternalUserId = ctx.identity.externalUserId;

  const channel: ChannelContext = {
    channelId,
    kind: ctx.channelRow.kind as ChannelContext["kind"],
    externalId: ctx.channelRow.externalId,
  };
  const inbound: Inbound = {
    channelId: String(channelId),
    externalMessageId:
      ctx.latest.tgMessageId !== null ? String(ctx.latest.tgMessageId) : String(ctx.latest.id),
    externalUserId: ctx.identity.externalUserId,
    parts: partsFromMetaJson(ctx.latest.metaJson, ctx.latest.text),
    receivedAt: ctx.latest.createdAt,
    raw: {},
  };
  const result: ProcessInboundResult = {
    contactId: conversation.userId,
    contactDisplayName: ctx.contact?.displayName ?? null,
    conversationId: conversation.id,
    persisted: true,
    outboundEnqueued: 0,
    userMessageText: text,
    userMessageId: ctx.latest.id,
    mediaOnly: false,
  };

  // #628 — «печатает…» на время генерации отложенного ответа (best-effort,
  // авто-переподнятие). signalTyping no-op для каналов без typing-capability.
  const stopTyping = deps.signalTyping
    ? startTypingKeepalive(
        () => deps.signalTyping?.(channelId, recipientExternalUserId) ?? Promise.resolve(),
      )
    : null;
  let gen: { outboundEnqueued: number };
  try {
    gen = await generateReplyAndEnqueue({
      db: deps.db,
      tenant: deps.tenant,
      channel,
      channelDbId: channelId,
      inbound,
      result,
      replyStrategy: deps.replyStrategy,
      notifications: deps.notifications ?? null,
      clock: deps.clock ?? systemClock,
      ...(deps.splitReplies ? { splitReplies: true } : {}),
      ...(deps.fallbackText ? { fallbackText: deps.fallbackText } : {}),
      ...(deps.handoffAfterFallbacks
        ? { handoffAfterFallbacks: deps.handoffAfterFallbacks }
        : {}),
      ...(deps.sink ? { sink: deps.sink } : {}),
    });
  } finally {
    stopTyping?.();
  }
  return { outboundEnqueued: gen.outboundEnqueued };
}
