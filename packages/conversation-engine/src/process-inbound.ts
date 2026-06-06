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
import { type MemoryExtractor, runMemoryExtraction } from "./memory-extractor.ts";
import { dispatchOutbound } from "./outbound-dispatch.ts";
import { applyClassifiedStage, type StageClassifier } from "./stage-classifier.ts";
import type { ITranscriber } from "./transcriber.ts";
import type { NotificationService } from "./notifications.ts";
import {
  ChannelContext,
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
   * Опциональный хэндлер inbound callback_query (нажатие inline-кнопки).
   * Если задан и callback обработан — возвращает реплику, которую pipeline
   * enqueue'ит. null = callback не обработан (прежнее поведение skip).
   * По умолчанию не задан → callbacks как раньше. Используется concierge-
   * витриной (req:<type>) — гейтинг внутри самого хэндлера.
   */
  handleCallback?: (input: {
    tenantId: number;
    contactId: number;
    conversationId: number;
    channelId: number;
    externalUserId: string;
    data: string;
    nowEpoch: number;
    db: import("./dal/types.ts").Db;
  }) => Promise<{ reply: import("@chatman-media/channel-core").OutboundEnvelope } | null>;
  /**
   * Vertical-template для текущей conversation. Если задан и в нём
   * есть hooks.extractFields — pipeline после persist user-message
   * дёрнет hook и merge'нёт извлечённые поля в contact.attributes_json.
   * Это даёт автозаполнение questionnaire (имя/возраст/паспорт/...)
   * без блокировки reply-loop.
   */
  template?: VerticalTemplate;
  /**
   * Опциональный LLM-based memory extractor. Если задан, после persist
   * user-message pipeline вытащит из истории facts через
   * extractUserFacts и merge'нёт в contact.attributes_json. Дополняет
   * template.hooks.extractFields (тот — regex; этот — LLM).
   */
  memoryExtractor?: MemoryExtractor;
  /**
   * Опциональный stage classifier (opener|qualify|pitch|objection|close).
   * Если задан, после persist user-message pipeline классифицирует stage
   * и пишет в conversations.current_stage (если отличается от previous).
   *
   * Sales-engine использует current_stage для выбора stage-specific
   * промптов в composeSystemPrompt; admin-UI — для отображения позиции
   * кандидата в воронке.
   */
  stageClassifier?: StageClassifier;
  /**
   * Drizzle db, нужен stage classifier'у для UPDATE conversations.current_stage.
   * Когда stageClassifier=null — может быть опущен.
   */
  db?: import("./dal/types.ts").Db;
  /**
   * Когда true — pipeline ЗАВЕРШАЕТСЯ после persist + classify + memory
   * extract БЕЗ вызова `reply.generate` и enqueue outbound. Result содержит
   * `replyDeferred: true`, `userMessageText`, `mediaOnly` — caller должен
   * затем вызвать `generateReplyAndEnqueue(...)` ВНЕ открытой Postgres-tx.
   *
   * Зачем: reply.generate — это LLM call ~1-2s, который не должен держать
   * Postgres pool connection. Pool=10, под нагрузкой это становится
   * bottleneck'ом. Split на phases освобождает connection для других
   * inbound'ов пока ждём LLM.
   *
   * Default false (legacy single-tx path для existing callers).
   */
  deferReply?: boolean;
  sink?: PipelineSink;
  clock?: Clock;
  notifications?: NotificationService;
  /**
   * Опциональный STT-транскрибер. Если задан и inbound содержит voice-part —
   * pipeline транскрибирует аудио перед persist'ом. Транскрипт становится
   * текстом сообщения; остальной pipeline работает без изменений.
   * downloadVoice должен быть задан вместе с transcriber.
   */
  transcriber?: ITranscriber | null;
  /** Загружает аудиофайл. Нужен для transcriber. externalUserId нужен userbot-адаптеру. */
  downloadVoice?: ((mediaRef: import("@chatman-media/channel-core").MediaRef, externalUserId: string) => Promise<Response>) | null;
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
 * Реализовано: vertical-hooks.extractFields (шаг 5), LLM-memory extraction
 * (шаг 5b), stage classifier (шаг 5a-bis), RAG + LLM reply через
 * ReplyStrategy (шаг 6). Оставшиеся TODO:
 *   - conversation summarization при длинных диалогах (context overflow)
 *   - escalation rules (не отвечать N часов → перевод в queued)
 *   - A/B routing (styleId → experiment allocation через ExperimentsRepo)
 *
 * Photo classification + passport OCR реализованы в apps/api/src/lib/
 * photo-processor.ts — выполняется ПОСЛЕ pipeline'а (Phase 4, async,
 * без tx) через PhotoProcessor.process().
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
  //    Если есть голосовые части и задан transcriber — транскрибируем сначала.
  if (deps.transcriber && deps.downloadVoice) {
    for (const part of inbound.parts) {
      if (part.kind === "voice") {
        try {
          const res = await deps.downloadVoice(part.mediaRef, inbound.externalUserId);
          if (res.ok) {
            const buf = await res.arrayBuffer();
            const transcript = await deps.transcriber.transcribe(
              new Uint8Array(buf),
              "voice.ogg",
            );
            if (transcript) {
              // Заменяем voice-part текстовым транскриптом в inbound.parts
              const idx = inbound.parts.indexOf(part);
              (inbound.parts as Array<(typeof inbound.parts)[number]>)[idx] = {
                kind: "text",
                text: transcript,
              };
            }
          }
        } catch (err) {
          deps.sink?.log?.("warn", "voice transcription failed", {
            tenantId: deps.tenant.tenantId,
            error: (err as Error).message,
          });
        }
      }
    }
  }
  const { text, mediaOnly } = inboundText(inbound);

  // callback_query — не сообщение в диалоге, а нажатие inline-кнопки.
  // Не персистим как user-message; если задан handleCallback — отдаём ему
  // (concierge-витрина req:<type>), реплику от него enqueue'им. Иначе skip.
  const cbPart = inbound.parts.find((p) => p.kind === "callback_query");
  if (cbPart) {
    let outboundEnqueued = 0;
    const data = cbPart.kind === "callback_query" ? cbPart.data : undefined;
    if (data && deps.handleCallback && deps.db) {
      try {
        const nowEpoch = Math.floor(Date.now() / 1000);
        const res = await deps.handleCallback({
          tenantId: deps.tenant.tenantId,
          contactId: contact.id,
          conversationId: conversation.id,
          channelId: deps.channelDbId,
          externalUserId: inbound.externalUserId,
          data,
          nowEpoch,
          db: deps.db,
        });
        if (res?.reply) {
          await deps.outbound.enqueue({
            channelId: deps.channelDbId,
            conversationId: conversation.id,
            envelope: res.reply,
            nowEpoch,
          });
          outboundEnqueued = 1;
        }
      } catch (err) {
        deps.sink?.log?.("warn", "handleCallback failed", {
          error: (err as Error).message,
        });
      }
    }
    return {
      contactId: contact.id,
      conversationId: conversation.id,
      persisted: false,
      outboundEnqueued,
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

  // 4. Update inbox state (touch TS, set preview, inc unread).
  if (!existingMsg) {
    await deps.conversations.updateInboxMetadata(conversation.id, {
      lastMessageAt: now,
      lastMessageText: text.slice(0, 200) || "(Медиа)",
      incrementUnread: true,
      // Если диалог был закрыт — переоткрываем.
      ...(conversation.status === "resolved" ? { status: "open" } : {}),
    });
  }

  // 4b. Notifications (Human takeover / Verification video / Document upload).
  const hasMedia = inbound.parts.some((p) => p.kind !== "text" && p.kind !== "callback_query");
  // «Кружок» (video_note) — опциональная видео-верификация: уходит оператору
  // на визуальную проверку личности (см. обменник). Поток не блокируется.
  const hasVideoNote = inbound.parts.some((p) => p.kind === "video_note");
  if (deps.notifications && !existingMsg) {
    if (conversation.mode === "human" || conversation.mode === "queued") {
      await deps.notifications.notify({
        tenantId: deps.tenant.tenantId,
        eventType: "human_takeover",
        conversationId: conversation.id,
        contactId: contact.id,
        data: {
          displayName: contact.displayName || "Без имени",
          text: text || "(Медиа)",
        },
      });
    } else if (hasVideoNote) {
      await deps.notifications.notify({
        tenantId: deps.tenant.tenantId,
        eventType: "verification_requested",
        conversationId: conversation.id,
        contactId: contact.id,
        data: {
          displayName: contact.displayName || "Без имени",
          text: text || "(Видео-кружок для верификации)",
        },
      });
    } else if (hasMedia) {
      await deps.notifications.notify({
        tenantId: deps.tenant.tenantId,
        eventType: "document_uploaded",
        conversationId: conversation.id,
        contactId: contact.id,
        data: {
          displayName: contact.displayName || "Без имени",
        },
      });
    }
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

  // 5a-bis. Stage classification (если classifier задан). Идёт ПОСЛЕ
  // extractFields и ПЕРЕД memory + reply: новая current_stage будет
  // прочитана reply-strategy'ей если она инжектит её в composeSystemPrompt.
  if (deps.stageClassifier && deps.db && !existingMsg && text.length > 0) {
    try {
      const newStage = await deps.stageClassifier.classify({
        tenantId: deps.tenant.tenantId,
        userMessageText: text,
        previousStage: conversation.currentStage,
        isFirstUserMessage: conversationCreated,
      });
      const changed = await applyClassifiedStage({
        db: deps.db,
        tenantId: deps.tenant.tenantId,
        conversationId: conversation.id,
        newStage,
      });
      if (changed) {
        deps.sink?.log?.("debug", "conversation stage classified", {
          tenantId: deps.tenant.tenantId,
          conversationId: conversation.id,
          from: conversation.currentStage,
          to: newStage,
        });
      }
    } catch (err) {
      deps.sink?.log?.("warn", "stage classifier failed", {
        tenantId: deps.tenant.tenantId,
        conversationId: conversation.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5b. LLM-based memory extraction (если extractor задан и не dedup).
  // Дополняет vertical-template extractFields: тот — regex (узкие шаблоны),
  // этот — LLM (русский NER, импликации). Exception → log, продолжаем.
  if (deps.memoryExtractor && !existingMsg && text.length > 0) {
    try {
      const extracted = await runMemoryExtraction({
        extractor: deps.memoryExtractor,
        tenantId: deps.tenant.tenantId,
        conversationId: conversation.id,
        contactId: contact.id,
        contacts: deps.contacts,
        nowEpoch: now,
      });
      if (Object.keys(extracted).length > 0) {
        deps.sink?.log?.("debug", "memory facts extracted", {
          tenantId: deps.tenant.tenantId,
          conversationId: conversation.id,
          keys: Object.keys(extracted),
        });
      }
    } catch (err) {
      deps.sink?.log?.("warn", "memory extractor failed", {
        tenantId: deps.tenant.tenantId,
        conversationId: conversation.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6. Reply generation.
  //
  // Когда `deferReply: true` — pipeline ВОЗВРАЩАЕТСЯ перед reply.generate,
  // caller вызывает generateReplyAndEnqueue вне открытой tx чтобы LLM call
  // не держал Postgres-connection (см. doc в ProcessInboundDeps.deferReply).
  if (deps.deferReply) {
    void messageId;
    return {
      contactId: contact.id,
      conversationId: conversation.id,
      persisted: !existingMsg,
      outboundEnqueued: 0,
      userMessageText: text,
      mediaOnly,
      replyDeferred: true,
    };
  }

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
      // 6b. Update lastMessageText to AI reply for the inbox list.
      const lastEnv = envelopes[envelopes.length - 1];
      if (lastEnv) {
        const aiText = lastEnv.parts.find((p) => p.kind === "text")?.text;
        if (aiText) {
          await deps.conversations.updateInboxMetadata(conversation.id, {
            lastMessageText: aiText.slice(0, 200),
          });
        }
      }

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
