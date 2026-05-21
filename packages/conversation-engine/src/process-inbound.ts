import type { Inbound, OutboundEnvelope } from "@chatman-media/channel-core";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { resolveContact } from "./contact-resolver.ts";
import { resolveConversation } from "./conversation-resolver.ts";
import type {
  ChannelIdentitiesRepo,
  ContactsRepo,
  ConversationsRepo,
  MessagesRepo,
  OutboundQueueRepo,
} from "./dal/index.ts";
import { dispatchOutbound } from "./outbound-dispatch.ts";
import {
  type ChannelContext,
  type Clock,
  type PipelineSink,
  type ProcessInboundResult,
  systemClock,
  type TenantContext,
} from "./types.ts";

/**
 * Стратегия генерации ответа. Pipeline сам не дёргает LLM напрямую —
 * вместо этого consumer (apps/worker) инжектит ReplyStrategy. Это
 * позволяет:
 *   - заменять стратегию для тестов на fake (вернёт фиксированный ответ)
 *   - поэтапно вводить RAG / sales-engine / vertical-hooks без trogания
 *     pipeline'а
 *   - выключать reply вообще (mediaOnly turn, режим оператора, и т.д.)
 *
 * Возвращает null — значит бот молчит. Возвращает envelope'ы — они
 * пушатся в outbound_queue в порядке возврата.
 */
export interface ReplyStrategy {
  generate(opts: {
    tenant: TenantContext;
    channel: ChannelContext;
    conversationId: number;
    contactId: number;
    inbound: Inbound;
    userMessageText: string;
  }): Promise<OutboundEnvelope[] | null>;
}

export interface ProcessInboundDeps {
  tenant: TenantContext;
  channel: ChannelContext;
  channelDbId: number;
  contacts: ContactsRepo;
  identities: ChannelIdentitiesRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  outbound: OutboundQueueRepo;
  /** Стратегия ответа. null = pipeline сохраняет inbound и не отвечает. */
  reply?: ReplyStrategy | null;
  /**
   * Vertical-template для текущей conversation. Если задан и в нём
   * есть hooks.extractFields — pipeline после persist user-message
   * дёрнет hook и merge'нёт извлечённые поля в contact.attributes_json.
   * Это даёт автозаполнение questionnaire (имя/возраст/паспорт/...)
   * без блокировки reply-loop.
   */
  template?: VerticalTemplate;
  sink?: PipelineSink;
  clock?: Clock;
}

/**
 * Извлекает «текст пользовательского сообщения» из канал-агностичного
 * Inbound для записи в messages.text. Caption у медиа считается текстом,
 * pure media (без caption) → пустая строка (но persisted=true с metaJson).
 *
 * Один Inbound может содержать несколько InboundPart (например, фото
 * с подписью). Здесь мы сворачиваем text-части в одну строку — БД-схема
 * messages.text single-column, multi-part модель будет в следующей
 * миграции (messages.parts_json).
 */
function inboundText(inbound: Inbound): { text: string; mediaOnly: boolean } {
  const textParts: string[] = [];
  let hasMedia = false;
  for (const part of inbound.parts) {
    if (part.kind === "text") textParts.push(part.text);
    else if ("caption" in part && part.caption) textParts.push(part.caption);
    if (part.kind !== "text" && part.kind !== "callback_query") hasMedia = true;
  }
  const text = textParts.join("\n").trim();
  return { text, mediaOnly: hasMedia && text.length === 0 };
}

/**
 * Основной pipeline. Channel-agnostic, tenant-scoped. apps/worker дёргает
 * это для каждого Inbound из ChannelAdapter.receive().
 *
 * Шаги:
 *   1. resolveContact — find/create Contact + ChannelIdentity
 *   2. resolveConversation — find/create Conversation per (contact, kind)
 *   3. Persist user message в messages (с idempotency через
 *      uniq_msg_user_tg)
 *   4. Если conversation.mode === 'ai' и reply-strategy задана → сгенерить
 *      OutboundEnvelope[]. Для 'queued'/'human' — pipeline пропускает
 *      генерацию (оператор отвечает сам).
 *   5. Push каждого envelope в outbound_queue.
 *   6. Touch conversations.last_message_at.
 *
 * Что отсутствует на этом этапе (TODO следующих итераций):
 *   - vertical-hooks (onLeadStageChange, extractFields)
 *   - memory extraction в users.profile_json
 *   - conversation summarization при длинных диалогах
 *   - photo-classification + dispatch в lead-hooks
 *   - escalation rules (не отвечать N часов → перевод в queued)
 *   - sales-engine call (style → A/B routing → coach feedback)
 *   - RAG: KB search + LLM reply
 */
export async function processInbound(
  inbound: Inbound,
  deps: ProcessInboundDeps,
): Promise<ProcessInboundResult> {
  const clock = deps.clock ?? systemClock;
  const now = clock.nowEpoch();

  deps.sink?.log?.("info", "inbound received", {
    tenantId: deps.tenant.tenantId,
    channelId: deps.channel.channelId,
    externalUserId: inbound.externalUserId,
    parts: inbound.parts.length,
  });

  // 1. Contact + identity.
  const contact = await resolveContact({
    inbound,
    channelDbId: deps.channelDbId,
    contacts: deps.contacts,
    identities: deps.identities,
  });

  // 2. Conversation.
  const { conversation, created: conversationCreated } = await resolveConversation({
    contactId: contact.id,
    channelKind: deps.channel.kind,
    conversations: deps.conversations,
    nowEpoch: now,
  });

  deps.sink?.emit?.({
    type: "inbound-received",
    tenantId: deps.tenant.tenantId,
    conversationId: conversation.id,
    inbound,
  });

  // 3. Persist message (с дедупом по external_message_id).
  const { text, mediaOnly } = inboundText(inbound);

  // Skip persist для callback_query — это не сообщение в диалоге,
  // а действие на кнопке (отрабатывается отдельным хэндлером).
  const isCallback = inbound.parts.some((p) => p.kind === "callback_query");
  if (isCallback) {
    return {
      contactId: contact.id,
      conversationId: conversation.id,
      persisted: false,
      outboundEnqueued: 0,
    };
  }

  const existingMsg = await deps.messages.findUserByExternalId(
    conversation.id,
    inbound.externalMessageId,
  );
  let messageId: number;
  if (existingMsg) {
    deps.sink?.log?.("debug", "inbound dedup hit", {
      conversationId: conversation.id,
      externalMessageId: inbound.externalMessageId,
    });
    messageId = existingMsg.id;
  } else {
    const inserted = await deps.messages.insert({
      conversationId: conversation.id,
      role: "user",
      text,
      externalMessageId: inbound.externalMessageId,
      ...(inbound.parts.some((p) => p.kind !== "text")
        ? { metaJson: JSON.stringify({ parts: inbound.parts }) }
        : {}),
      nowEpoch: now,
    });
    messageId = inserted.id;
    deps.sink?.emit?.({
      type: "message-persisted",
      tenantId: deps.tenant.tenantId,
      conversationId: conversation.id,
      messageId: inserted.id,
      role: "user",
    });
  }

  // 4. Touch last_message_at если это not-a-dup и не fresh-created.
  if (!conversationCreated && !existingMsg) {
    await deps.conversations.touchLastMessageAt(conversation.id, now);
  }

  // 5. Vertical extractFields hook (если задан и не дублирующийся inbound).
  // Hook резолвит structured fields из текста (имя/возраст/паспорт/etc.)
  // и сохраняет их в contact.attributes_json. Дублям hook не зовётся —
  // повторный extract на retry'е webhook'а не должен переписывать данные.
  if (deps.template?.hooks?.extractFields && !existingMsg && text.length > 0) {
    try {
      const extracted = await deps.template.hooks.extractFields(
        { tenantId: deps.tenant.tenantId, contactId: contact.id, conversationId: conversation.id },
        text,
      );
      if (extracted && Object.keys(extracted).length > 0) {
        await deps.contacts.mergeAttributes(contact.id, extracted, now);
      }
    } catch (err) {
      // Hook-failure не должен ломать main pipeline — reply всё равно
      // должен сработать. Логируем, продолжаем.
      deps.sink?.log?.("warn", "extractFields hook failed", {
        tenantId: deps.tenant.tenantId,
        conversationId: conversation.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6. Reply generation.
  let outboundCount = 0;
  if (conversation.mode === "ai" && deps.reply && !mediaOnly) {
    const envelopes = await deps.reply.generate({
      tenant: deps.tenant,
      channel: deps.channel,
      conversationId: conversation.id,
      contactId: contact.id,
      inbound,
      userMessageText: text,
    });
    if (envelopes && envelopes.length > 0) {
      for (const env of envelopes) {
        const queued = await dispatchOutbound({
          channelDbId: deps.channelDbId,
          conversationId: conversation.id,
          envelope: env,
          outbound: deps.outbound,
          nowEpoch: now,
        });
        outboundCount += 1;
        deps.sink?.emit?.({
          type: "outbound-enqueued",
          tenantId: deps.tenant.tenantId,
          conversationId: conversation.id,
          queueItemId: queued.id,
          envelope: env,
        });
      }
    }
  }

  void messageId;
  return {
    contactId: contact.id,
    conversationId: conversation.id,
    persisted: !existingMsg,
    outboundEnqueued: outboundCount,
  };
}
