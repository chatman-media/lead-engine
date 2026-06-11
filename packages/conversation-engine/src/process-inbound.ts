import type {
  Inbound,
  InboundPart,
  MediaRef,
  OperatorHandoffMeta,
  OutboundEnvelope,
} from "@chatman-media/channel-core";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { resolveContact } from "./contact-resolver.ts";
import { resolveConversation } from "./conversation-resolver.ts";
import type {
  ChannelIdentitiesRepo,
  ContactsRepo,
  ConversationsRepo,
  LeadsRepo,
  MessagesRepo,
  OutboundQueueRepo,
} from "./dal/index.ts";
import { ensureAndAdvanceLeadByPhase } from "./lead-advance.ts";
import { type MemoryExtractor, runMemoryExtraction } from "./memory-extractor.ts";
import { dispatchOutbound } from "./outbound-dispatch.ts";
import {
  emitOperatorHandoffNotifications,
  operatorMediaNotificationData,
  primaryOperatorHandoff,
} from "./operator-handoff.ts";
import { applyClassifiedStage, type StageClassifier } from "./stage-classifier.ts";
import type { ITranscriber } from "./transcriber.ts";
import type { NotificationService } from "./notifications.ts";
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
  }): Promise<ReplyStrategyResult>;
}

export interface ReplyStrategyOutput {
  envelopes: OutboundEnvelope[];
  operatorHandoffs?: OperatorHandoffMeta[];
  autoTakeover?: boolean;
  customerNoticeSent?: boolean;
}

export type ReplyStrategyResult = OutboundEnvelope[] | ReplyStrategyOutput | null;

export function normalizeReplyStrategyResult(
  result: ReplyStrategyResult,
): ReplyStrategyOutput | null {
  if (!result) return null;
  const envelopes = Array.isArray(result) ? result : result.envelopes;
  const explicitHandoffs = Array.isArray(result) ? [] : (result.operatorHandoffs ?? []);
  const envelopeHandoffs = envelopes
    .map((envelope) => envelope.operatorHandoff)
    .filter((handoff): handoff is OperatorHandoffMeta => Boolean(handoff));
  return {
    envelopes,
    operatorHandoffs: [...explicitHandoffs, ...envelopeHandoffs],
    autoTakeover: Array.isArray(result) ? false : result.autoTakeover === true,
    customerNoticeSent: Array.isArray(result)
      ? envelopes.some((envelope) => envelope.parts.length > 0)
      : result.customerNoticeSent === true,
  };
}

function outboundEnvelopeText(envelope: OutboundEnvelope): string | null {
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

export interface ProcessInboundDeps {
  tenant: TenantContext;
  channel: ChannelContext;
  channelDbId: number;
  contacts: ContactsRepo;
  identities: ChannelIdentitiesRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  outbound: OutboundQueueRepo;
  /**
   * Опциональный LeadsRepo. Если задан вместе с `template` и `stageClassifier`,
   * pipeline авто-создаёт Lead, как только цель/интент клиента определён
   * (stage classifier вернул стадию ≠ "opener"). Без него лиды не создаются
   * из диалога (legacy-поведение).
   */
  leads?: LeadsRepo;
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
  /**
   * Опциональный LLM-based memory extractor. Если задан, после persist
   * user-message pipeline вытащит из истории facts через
   * extractUserFacts и merge'нёт в contact.attributes_json. Дополняет
   * template.hooks.extractFields (тот — regex; этот — LLM).
   *
   * Если `deferPostProcessing=true`, processInbound НЕ вызывает extractor
   * внутри текущей DB transaction; caller должен вызвать
   * runDeferredInboundPostProcessing(...) перед reply.generate.
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
   *
   * Если `deferPostProcessing=true`, processInbound НЕ вызывает classifier
   * внутри текущей DB transaction; caller должен вызвать
   * runDeferredInboundPostProcessing(...) перед reply.generate.
   */
  stageClassifier?: StageClassifier;
  /**
   * Drizzle db, нужен stage classifier'у для UPDATE conversations.current_stage.
   * Когда stageClassifier=null — может быть опущен.
   */
  db?: import("./dal/types.ts").Db;
  /**
   * Когда true — pipeline ЗАВЕРШАЕТСЯ после persist/post-processing boundary
   * БЕЗ вызова `reply.generate` и enqueue outbound. Result содержит
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
  /**
   * Когда true — stageClassifier + memoryExtractor не вызываются внутри
   * текущей transaction. Используется webhook/runner split-pipeline:
   *
   *   tx1 persist → outside tx classify/extract → tx1b write stage/memory →
   *   outside tx reply.generate → tx2 enqueue
   *
   * Default false сохраняет legacy single-call behavior.
   */
  deferPostProcessing?: boolean;
  sink?: PipelineSink;
  clock?: Clock;
  notifications?: NotificationService;
}

type VoicePart = Extract<InboundPart, { kind: "voice" }>;

export interface TranscribeInboundVoiceDeps {
  tenantId: number;
  transcriber?: ITranscriber | null;
  resolveTranscriber?: (() => ITranscriber | null) | null;
  /** Загружает аудиофайл. externalUserId нужен userbot-адаптеру. */
  downloadVoice?: ((mediaRef: MediaRef, externalUserId: string) => Promise<Response>) | null;
  sink?: PipelineSink;
}

/**
 * Optional pre-persist STT phase. This helper intentionally does media download
 * and transcription outside `withTenant`; `processInbound` must stay DB-only.
 */
export async function transcribeInboundVoice(
  inbound: Inbound,
  deps: TranscribeInboundVoiceDeps,
): Promise<Inbound> {
  const voiceParts = inbound.parts.filter((part): part is VoicePart => part.kind === "voice");
  if (voiceParts.length === 0 || !deps.downloadVoice) return inbound;

  const transcriber = deps.transcriber ?? deps.resolveTranscriber?.() ?? null;
  if (!transcriber) return inbound;

  for (const part of voiceParts) {
    try {
      const res = await deps.downloadVoice(part.mediaRef, inbound.externalUserId);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const transcript = await transcriber.transcribe(new Uint8Array(buf), "voice.ogg");
        if (transcript) {
          const idx = inbound.parts.indexOf(part);
          inbound.parts[idx] = { kind: "text", text: transcript };
        }
      }
    } catch (err) {
      deps.sink?.log?.("warn", "voice transcription failed", {
        tenantId: deps.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return inbound;
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

function exchangeMediaHandoffData(input: {
	text: string;
	currentStage?: string | null;
	hasVideoNote: boolean;
}): OperatorHandoffMeta {
	const signal = `${input.text}\n${input.currentStage ?? ""}`.toLowerCase();
	const paymentLike =
		/(?:чек|оплат|receipt|proof|перевод|плат[её]ж|payment)/iu.test(signal);
	if (paymentLike && !input.hasVideoNote) {
		return {
			reason: "payment_review",
			title: "Проверить оплату по чеку",
			action:
				"Сверить чек/поступление, сумму, банк/rail и отправителя. После проверки подтвердить оплату или отметить проблему.",
			priority: "high",
			pending: "operator_payment_review",
			reviewPath:
				"operator_bot: payment_confirmed / payment_under_review / payment_problem",
		};
	}
	return {
		reason: "kyc_review",
		title: "Проверить KYC клиента",
		action:
			"Проверить документ/фото/видео клиента, принять решение: KYC OK, запросить материалы или отклонить.",
		priority: "high",
		pending: "operator_kyc_decision",
		reviewPath:
			"operator_bot: kyc_approved / kyc_request_materials / kyc_rejected",
	};
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
    channelId: deps.channelDbId,
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
  //    Голосовые parts должны быть транскрибированы до вызова processInbound,
  //    чтобы media download + STT не держали открытую DB transaction.
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
  const postProcessingDeferred =
    Boolean(deps.deferPostProcessing) && !existingMsg && text.length > 0;
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
  let escalatedReason: string | undefined;
  if (
    !existingMsg &&
    conversation.mode === "ai" &&
    deps.template?.slug === "exchange_v1" &&
    hasMedia
  ) {
    const handoff = exchangeMediaHandoffData({
      text,
      currentStage: conversation.currentStage,
      hasVideoNote,
    });
    await deps.conversations.applyAutoHandoff({
      conversationId: conversation.id,
      reason: handoff.reason,
      ...(handoff.orderId !== undefined ? { orderId: handoff.orderId } : {}),
      ...(handoff.stageSlug ? { stageSlug: handoff.stageSlug } : {}),
      customerNoticeSent: false,
      nowEpoch: now,
    });
    escalatedReason = handoff.reason;
    await emitOperatorHandoffNotifications({
      tenantId: deps.tenant.tenantId,
      conversationId: conversation.id,
      contactId: contact.id,
      contactDisplayName: contact.displayName,
      userMessageText: text,
      inbound,
      envelopes: [],
      operatorHandoffs: [handoff],
      notifications: deps.notifications ?? null,
      ...(deps.sink ? { sink: deps.sink } : {}),
    });
  } else if (deps.notifications && !existingMsg) {
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
          action:
            "Необходимо верифицировать клиента и документы перед выдачей реквизитов.",
          ...operatorMediaNotificationData(inbound),
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
          text: text || "(Клиент загрузил документ/медиа)",
          action: "Проверьте документ и сопоставьте его с заявкой клиента.",
          ...operatorMediaNotificationData(inbound),
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
  if (
    !postProcessingDeferred &&
    deps.stageClassifier &&
    deps.db &&
    !existingMsg &&
    text.length > 0
  ) {
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

      // Цель/интент определён (стадия ≠ opener) → заводим лид и продвигаем
      // его по фазам воронки в такт диалогу (qualify→offer→clear→fulfill).
      // Гейт — deps.leads (opt-in); сама работа идёт по DB-воронке тенанта.
      if (newStage && newStage !== "opener" && deps.leads && deps.db) {
        try {
          const res = await ensureAndAdvanceLeadByPhase({
            db: deps.db,
            tenantId: deps.tenant.tenantId,
            contactId: contact.id,
            salesStage: newStage,
            nowEpoch: now,
          });
          if (res && (res.created || res.advanced)) {
            deps.sink?.log?.("info", res.created ? "lead auto-created" : "lead advanced", {
              tenantId: deps.tenant.tenantId,
              conversationId: conversation.id,
              contactId: contact.id,
              leadId: res.leadId,
              stage: res.stageSlug,
              salesStage: newStage,
            });
          }
        } catch (err) {
          deps.sink?.log?.("warn", "lead auto-advance failed", {
            tenantId: deps.tenant.tenantId,
            conversationId: conversation.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
  if (!postProcessingDeferred && deps.memoryExtractor && !existingMsg && text.length > 0) {
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
      contactDisplayName: contact.displayName,
      conversationId: conversation.id,
      persisted: !existingMsg,
      outboundEnqueued: 0,
      userMessageText: text,
      mediaOnly,
      postProcessingDeferred,
      previousStage: conversation.currentStage,
      conversationCreated,
      ...(escalatedReason ? { escalatedReason } : {}),
      replyDeferred: true,
    };
  }

  let outboundCount = 0;
  if (conversation.mode === "ai" && !escalatedReason && deps.reply && !mediaOnly) {
    const replyOutput = normalizeReplyStrategyResult(
      await deps.reply.generate({
        tenant: deps.tenant,
        channel: deps.channel,
        conversationId: conversation.id,
        contactId: contact.id,
        inbound,
        userMessageText: text,
      }),
    );
    if (
      replyOutput &&
      (replyOutput.envelopes.length > 0 ||
        (replyOutput.autoTakeover && (replyOutput.operatorHandoffs?.length ?? 0) > 0))
    ) {
      const envelopes = replyOutput.envelopes;
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
        const aiText = outboundEnvelopeText(env);
        if (aiText) {
          const inserted = await deps.messages.insert({
            conversationId: conversation.id,
            role: "assistant",
            text: aiText,
            nowEpoch: now,
          });
          deps.sink?.emit?.({
            type: "message-persisted",
            tenantId: deps.tenant.tenantId,
            conversationId: conversation.id,
            messageId: inserted.id,
            role: "assistant",
          });
        }
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
      if (replyOutput.autoTakeover) {
        const handoff = primaryOperatorHandoff(replyOutput.operatorHandoffs);
        if (handoff) {
          await deps.conversations.applyAutoHandoff({
            conversationId: conversation.id,
            reason: handoff.reason,
            ...(handoff.orderId !== undefined ? { orderId: handoff.orderId } : {}),
            ...(handoff.stageSlug ? { stageSlug: handoff.stageSlug } : {}),
            customerNoticeSent: replyOutput.customerNoticeSent === true,
            nowEpoch: now,
          });
          escalatedReason = handoff.reason;
        }
      }
      await emitOperatorHandoffNotifications({
        tenantId: deps.tenant.tenantId,
        conversationId: conversation.id,
        contactId: contact.id,
        contactDisplayName: contact.displayName,
        userMessageText: text,
        inbound,
        envelopes,
        ...(replyOutput.operatorHandoffs
          ? { operatorHandoffs: replyOutput.operatorHandoffs }
          : {}),
        notifications: deps.notifications ?? null,
        ...(deps.sink ? { sink: deps.sink } : {}),
      });
    }
  }

  void messageId;
  return {
    contactId: contact.id,
    contactDisplayName: contact.displayName,
    conversationId: conversation.id,
    persisted: !existingMsg,
    outboundEnqueued: outboundCount,
    ...(deps.deferPostProcessing
      ? {
          userMessageText: text,
          mediaOnly,
          postProcessingDeferred,
          previousStage: conversation.currentStage,
          conversationCreated,
        }
      : {}),
    ...(escalatedReason ? { escalatedReason } : {}),
  };
}
