/**
 * Concierge click-витрина — Фаза 2 остаток (#175).
 *
 * Два компонента:
 *
 * 1. `wrapWithConciergeButtons` — оборачивает ReplyStrategy: когда лид гостя
 *    находится на intake-стадии concierge_v1 (`request_received`), к последнему
 *    OutboundEnvelope добавляется inline-клавиатура с кнопками типов услуг.
 *    Гость может нажать кнопку вместо ввода текста.
 *
 * 2. `expandCallbackQuery` — конвертирует Inbound с `callback_query`
 *    вида `srv:<type>` в синтетическое text-сообщение с названием услуги,
 *    чтобы field-extractor классифицировал его как request_type без изменений
 *    в conversation-engine. Возвращает null если data не concierge-кнопка.
 */

import type { Inbound, ReplyMarkup } from "@chatman-media/channel-core";
import type { Db } from "@chatman-media/conversation-engine";
import type { ReplyStrategy } from "@chatman-media/conversation-engine";
import { leads, stageDefinitions } from "@chatman-media/storage";
import { and, desc, eq, notInArray } from "drizzle-orm";

// ── Кнопки витрины ─────────────────────────────────────────────────────────────

export const CONCIERGE_INTAKE_STAGE = "request_received";

/** callback_data для кнопок витрины. Префикс "srv:" не должен конфликтовать с другими. */
export const SERVICE_BUTTON_PREFIX = "srv:";

/** Отображаемое имя услуги по callback_data. */
export const SERVICE_LABEL: Record<string, string> = {
  exchange: "Обмен валюты",
  transfer: "Трансфер",
  food: "Доставка еды",
  housekeeping: "Уборка",
  tour: "Экскурсия",
};

/** Inline-клавиатура витрины (2 столбца + отдельная строка для тура). */
const CONCIERGE_REPLY_MARKUP: ReplyMarkup = {
  inlineButtons: [
    [
      { label: "💱 Обмен валюты", callbackData: `${SERVICE_BUTTON_PREFIX}exchange` },
      { label: "🚗 Трансфер", callbackData: `${SERVICE_BUTTON_PREFIX}transfer` },
    ],
    [
      { label: "🍕 Еда", callbackData: `${SERVICE_BUTTON_PREFIX}food` },
      { label: "🧹 Уборка", callbackData: `${SERVICE_BUTTON_PREFIX}housekeeping` },
    ],
    [
      { label: "🏖 Экскурсия", callbackData: `${SERVICE_BUTTON_PREFIX}tour` },
    ],
  ],
};

// ── Helpers ────────────────────────────────────────────────────────────────────

async function resolveOpenLeadStageSlug(
  db: Db,
  tenantId: number,
  contactId: number,
): Promise<string | null> {
  const rows = await db
    .select({ slug: stageDefinitions.slug, kind: stageDefinitions.kind })
    .from(leads)
    .leftJoin(stageDefinitions, eq(leads.stageDefinitionId, stageDefinitions.id))
    .where(
      and(
        eq(leads.tenantId, tenantId),
        eq(leads.userId, contactId),
        notInArray(stageDefinitions.kind, ["terminal_won", "terminal_lost"]),
      ),
    )
    .orderBy(desc(leads.updatedAt))
    .limit(1);
  return rows[0]?.slug ?? null;
}

// ── Strategy wrapper ───────────────────────────────────────────────────────────

/**
 * Оборачивает strategy: если контакт на `request_received` стадии concierge —
 * добавляет inline-кнопки услуг к последнему envelope'у ответа.
 * Для всех других стадий/вертикалей поведение не меняется.
 */
export function wrapWithConciergeButtons(
  strategy: ReplyStrategy,
  db: Db,
): ReplyStrategy {
  return {
    generate: async (opts) => {
      const envelopes = await strategy.generate(opts);
      if (!envelopes || envelopes.length === 0) return envelopes;

      let stageSlug: string | null = null;
      try {
        stageSlug = await resolveOpenLeadStageSlug(
          db,
          opts.tenant.tenantId,
          opts.contactId,
        );
      } catch {
        // Не ломаем reply при ошибке резолвинга стадии.
        return envelopes;
      }
      if (stageSlug !== CONCIERGE_INTAKE_STAGE) return envelopes;

      // Добавляем кнопки к последнему envelope'у.
      const last = envelopes[envelopes.length - 1]!;
      return [
        ...envelopes.slice(0, -1),
        { ...last, replyMarkup: CONCIERGE_REPLY_MARKUP },
      ];
    },
  };
}

// ── Callback query expander ────────────────────────────────────────────────────

export interface ExpandedCallback {
  /** Синтетический Inbound с text-парт вместо callback_query. */
  syntheticInbound: Inbound;
  /** callbackQueryId для answerCallbackQuery (убирает спиннер на кнопке). */
  callbackQueryId: string;
  /** Человекочитаемое название услуги (для логов). */
  serviceLabel: string;
}

/**
 * Если Inbound содержит callback_query с data = `srv:<type>`, возвращает
 * синтетический text-Inbound с именем услуги и callbackQueryId для ack'а.
 * Возвращает null если это не concierge-кнопка.
 */
export function expandCallbackQuery(inbound: Inbound): ExpandedCallback | null {
  const part = inbound.parts[0];
  if (!part || part.kind !== "callback_query") return null;
  const { data } = part as { kind: "callback_query"; data: string; originalMessageId?: string };
  if (!data.startsWith(SERVICE_BUTTON_PREFIX)) return null;

  const serviceKey = data.slice(SERVICE_BUTTON_PREFIX.length);
  const serviceLabel = SERVICE_LABEL[serviceKey] ?? serviceKey;

  const syntheticInbound: Inbound = {
    ...inbound,
    // Новый synthetic externalMessageId чтобы не было dedup-коллизии
    // с оригинальным callback_query update. Формат: "cb:<original>:<data>"
    externalMessageId: `cb:${inbound.externalMessageId}:${data}`,
    parts: [{ kind: "text", text: serviceLabel }],
  };

  // callbackQueryId живёт в raw TgUpdate — достаём через raw (если есть).
  // Если raw недоступен — передаём inbound.externalMessageId как fallback.
  const raw = inbound.raw as Record<string, unknown> | undefined;
  const cbQuery = raw?.callback_query as Record<string, unknown> | undefined;
  const callbackQueryId = String(cbQuery?.id ?? inbound.externalMessageId);

  return { syntheticInbound, callbackQueryId, serviceLabel };
}
