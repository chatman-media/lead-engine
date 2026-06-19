import type { Inbound, OutboundEnvelope } from "@chatman-media/channel-core";
import { ConversationsRepo } from "./dal/conversations.ts";
import { MessagesRepo } from "./dal/messages.ts";
import { OutboundQueueRepo } from "./dal/outbound.ts";
import type { Db } from "./dal/types.ts";
import { dispatchOutbound } from "./outbound-dispatch.ts";
import { EXCHANGE_SAFE_FALLBACK } from "./reply-strategy/exchange-reply-guard.ts";
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
  /**
   * #628 — резать длинный текстовый ответ по «пустой строке» (двойной \n) на
   * несколько отдельных сообщений (человечнее). Применяется к чисто-текстовым
   * envelope'ам без кнопок/медиа; остальные не трогаем.
   */
  splitReplies?: boolean;
  /**
   * #630 — кастомный текст фолбэка «уточню у оператора». Если бот эмитит
   * стандартный EXCHANGE_SAFE_FALLBACK — заменяем его на этот текст.
   */
  fallbackText?: string | null;
  /**
   * #627 — после N ПОДРЯД фолбэков бота передаём диалог оператору (mode=human).
   * 0/undefined — выключено. Счётчик в conversations.meta_json.fallbackStreak.
   */
  handoffAfterFallbacks?: number | null;
}

export interface GenerateReplyResult {
  /** Кол-во envelope'ов поставлено в outbound_queue. 0 если reply пустой
   *  или mediaOnly или conversation.mode != 'ai' (но проверка mode не
   *  делается тут — caller сам решает по результату processInbound). */
  outboundEnqueued: number;
  escalatedReason?: string;
}

/**
 * #628 — дробит чисто-текстовые envelope'ы на несколько по пустой строке.
 * Envelope с reply_markup/медиа/несколькими частями не трогаем (кнопки должны
 * остаться под одним сообщением). Текст без двойного \n остаётся как есть.
 */
function splitReplyEnvelopes(envelopes: OutboundEnvelope[]): OutboundEnvelope[] {
  const out: OutboundEnvelope[] = [];
  for (const env of envelopes) {
    const onlyText =
      env.parts.length === 1 &&
      env.parts[0]?.kind === "text" &&
      !env.replyMarkup &&
      env.replyToExternalMessageId === undefined;
    if (!onlyText) {
      out.push(env);
      continue;
    }
    const text = (env.parts[0] as { kind: "text"; text: string }).text;
    const chunks = text
      .split(/\n\s*\n/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (chunks.length <= 1) {
      out.push(env);
      continue;
    }
    for (const chunk of chunks) {
      out.push({ ...env, parts: [{ kind: "text", text: chunk }] });
    }
  }
  return out;
}

/** #627/#630 — реплай является стандартным фолбэком «уточню у оператора»? */
function isFallbackReply(envelopes: OutboundEnvelope[]): boolean {
  return envelopes.some((env) =>
    env.parts.some((p) => p.kind === "text" && p.text.trim() === EXCHANGE_SAFE_FALLBACK),
  );
}

/** #630 — заменить стандартный фолбэк-текст на кастомный (per-tenant). */
function replaceFallbackText(
  envelopes: OutboundEnvelope[],
  customText: string,
): OutboundEnvelope[] {
  return envelopes.map((env) => ({
    ...env,
    parts: env.parts.map((p) =>
      p.kind === "text" && p.text.trim() === EXCHANGE_SAFE_FALLBACK
        ? { ...p, text: customText }
        : p,
    ),
  }));
}

/**
 * #653 — окно анти-дубля: не шлём текстовый ответ, байт-в-байт совпадающий со
 * свежим (≤ окна) сообщением бота. Ловит конкурентную двойную генерацию (два
 * входящих без debounce отвечают почти одновременно — content-гард стратегии не
 * видит ещё не записанный ответ; гонка укладывается в секунды). Легитимные
 * повторы дальше окна проходят. Фолбэки (#627) НЕ дедупим — серия одинаковых
 * фолбэков намеренно копится до порога передачи оператору.
 */
const REPLY_DEDUP_WINDOW_SEC = 20;

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
      ...(result.userMessageId !== undefined
        ? { userMessageId: result.userMessageId }
        : {}),
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

  // #627/#630 — фолбэк ли это («уточню у оператора»)? Детектим ДО замены текста.
  const replyIsFallback = isFallbackReply(replyOutput.envelopes as OutboundEnvelope[]);
  let baseEnvelopes = replyOutput.envelopes as OutboundEnvelope[];
  if (replyIsFallback && deps.fallbackText) {
    baseEnvelopes = replaceFallbackText(baseEnvelopes, deps.fallbackText); // #630
  }

  // ── Phase 2B: enqueue в новой короткой tx ────────────────────────────
  const now = clock.nowEpoch();
  let count = 0;
  let escalatedReason: string | undefined;
  let escalationChanged = false;
  await withTenant(deps.db, tenant.tenantId, async (tx) => {
    const repoCtx = { db: tx, tenantId: tenant.tenantId };
    const conversations = new ConversationsRepo(repoCtx);
    const messages = new MessagesRepo(repoCtx);
    const outbound = new OutboundQueueRepo({ db: tx, tenantId: tenant.tenantId });
    // Нужен оператор (handoff) → полный молчок: клиенту НЕ отвечаем, диалог
    // уходит человеку. Иначе бот и отвечал, и слал «нужен оператор» каждый ход.
    const envelopesToSend = needsAutoTakeover
      ? []
      : deps.splitReplies
        ? splitReplyEnvelopes(baseEnvelopes)
        : baseEnvelopes;
    // #653 — анти-дубль: свежие сообщения бота для сверки байт-в-байт.
    const recentForDedup = await messages.recent(result.conversationId, 5);
    const isRecentBotDuplicate = (txt: string): boolean =>
      recentForDedup.some(
        (m) =>
          (m.role === "assistant" || m.role === "human") &&
          m.text === txt &&
          now - m.createdAt <= REPLY_DEDUP_WINDOW_SEC,
      );
    for (const env of envelopesToSend) {
      const aiText = envelopeText(env);
      if (aiText && !replyIsFallback && isRecentBotDuplicate(aiText)) {
        deps.sink?.log?.("debug", "reply dedup: identical recent bot message skipped", {
          tenantId: tenant.tenantId,
          conversationId: result.conversationId,
        });
        continue;
      }
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
        const ho = await conversations.applyAutoHandoff({
          conversationId: result.conversationId,
          reason: handoff.reason,
          ...(handoff.orderId !== undefined ? { orderId: handoff.orderId } : {}),
          ...(handoff.stageSlug ? { stageSlug: handoff.stageSlug } : {}),
          customerNoticeSent: false,
          nowEpoch: now,
        });
        escalationChanged = ho?.changed ?? false;
        escalatedReason = handoff.reason;
      }
    }

    // #627 — серия подряд-фолбэков: считаем (сброс на не-фолбэке) и при
    // достижении порога передаём диалог оператору.
    if (count > 0 && !escalatedReason) {
      const streak = await conversations.bumpFallbackStreak(
        result.conversationId,
        replyIsFallback,
        now,
      );
      const threshold = deps.handoffAfterFallbacks ?? 0;
      if (replyIsFallback && threshold > 0 && streak >= threshold) {
        await conversations.applyAutoHandoff({
          conversationId: result.conversationId,
          reason: "fallback_streak",
          customerNoticeSent: true,
          nowEpoch: now,
        });
        escalatedReason = "fallback_streak";
      }
    }
  });
  // Уведомляем оператора ОДИН раз — на первой эскалации (applyAutoHandoff.changed).
  // Раньше дубль «нужен оператор» сыпался на каждое сообщение уже-эскалированного диалога.
  if (escalationChanged) {
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
  }
  // #627 — уведомить оператора о передаче по серии фолбэков.
  if (escalatedReason === "fallback_streak" && deps.notifications) {
    try {
      await deps.notifications.notify({
        tenantId: tenant.tenantId,
        eventType: "human_takeover",
        conversationId: result.conversationId,
        contactId: result.contactId,
        data: {
          displayName: result.contactDisplayName || "Без имени",
          text: text || "",
          reason: "fallback_streak",
        },
      });
    } catch {
      // уведомление не должно ломать reply-loop
    }
  }
  return {
    outboundEnqueued: count,
    ...(escalatedReason ? { escalatedReason } : {}),
  };
}
