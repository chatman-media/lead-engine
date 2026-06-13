/**
 * Риск-чек обмена (п.10 ТЗ). Детерминированные правила в коде, НЕ в промпте:
 *   - лимиты суммы (берутся из exchange_rates, проверяются ещё на этапе котировки);
 *   - дубли: уже есть открытая заявка в этой беседе;
 *   - AML-хук для адреса отправителя крипты (расширяемая заглушка).
 *
 * Результат сохраняется в exchange_orders.risk_json. ok=false НЕ создаёт заявку.
 */

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { exchangeOrders, exchangeSettings } from "@chatman-media/storage";
import { and, eq, inArray } from "drizzle-orm";

export interface RiskResult {
  ok: boolean;
  reasons: string[];
  /** требуется ручная проверка оператором (не блок, но флаг) */
  needsOperator?: boolean;
}

const OPEN_STATUSES = ["quote", "awaiting_payment", "paid", "payout"] as const;

/**
 * Проверяет, нет ли уже активной (незавершённой) заявки в этой беседе.
 * Возвращает id найденной заявки или null.
 */
export async function findOpenOrderId(
  db: Db,
  tenantId: number,
  conversationId: number,
): Promise<number | null> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: exchangeOrders.id })
      .from(exchangeOrders)
      .where(
        and(
          eq(exchangeOrders.tenantId, tenantId),
          eq(exchangeOrders.conversationId, conversationId),
          inArray(exchangeOrders.status, OPEN_STATUSES as unknown as string[]),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  });
}

/**
 * AML-хук для адреса-отправителя крипты. По умолчанию пропускает всё —
 * точка расширения для подключения реального AML-провайдера (Chainalysis и т.п.).
 */
export async function screenSenderAddress(
  _address: string,
  _asset: string,
  _network: string,
): Promise<{ ok: boolean; reason?: string }> {
  // TODO: интеграция с AML-провайдером. Сейчас — пропускаем (фиксируем в risk_json).
  return { ok: true };
}

/**
 * Риск-чек перед созданием заявки.
 *   - hard-block (ok=false): дубль активной заявки в беседе, невменяемая сумма.
 *   - manual-review (ok=true, needsOperator=true): настраиваемые правила из
 *     exchange_settings — суммовой порог, первая сделка клиента, суточный лимит.
 *     Заявка создаётся, но реквизиты придерживаются до одобрения оператором.
 */
export async function assessOrderRisk(
  db: Db,
  tenantId: number,
  input: {
    conversationId: number;
    amountToThb: number;
    /** Для правил «первая сделка»/«суточный лимит». */
    contactId?: number | null;
    /** Эпоха для окна 24ч (для тестов). */
    now?: number;
  },
): Promise<RiskResult> {
  const reasons: string[] = [];
  let ok = true;

  const openId = await findOpenOrderId(db, tenantId, input.conversationId);
  if (openId !== null) {
    ok = false;
    reasons.push(`В этой беседе уже есть незавершённая заявка #${openId}.`);
  }

  if (!Number.isFinite(input.amountToThb) || input.amountToThb <= 0) {
    ok = false;
    reasons.push("Некорректная сумма к получению.");
  }

  if (!ok) return { ok, reasons };

  // Настраиваемые правила → ручная проверка оператором (не блок).
  const manualReasons = await evaluateManualReviewRules(db, tenantId, input);
  if (manualReasons.length > 0) {
    reasons.push(...manualReasons);
    return { ok: true, reasons, needsOperator: true };
  }
  return { ok: true, reasons };
}

/** Статусы, которые считаем «оборотом» клиента за окно (без cancelled/expired). */
const DAILY_COUNTED_STATUSES = new Set([
  "quote",
  "awaiting_payment",
  "paid",
  "payout",
  "completed",
]);

/**
 * Применяет настраиваемые risk-review правила (exchange_settings) и возвращает
 * список причин для ручной проверки (пусто → правила не сработали / выключены).
 */
async function evaluateManualReviewRules(
  db: Db,
  tenantId: number,
  input: { amountToThb: number; contactId?: number | null; now?: number },
): Promise<string[]> {
  return withTenant(db, tenantId, async (tx) => {
    const [s] = await tx
      .select({
        amountThreshold: exchangeSettings.riskAmountThreshold,
        firstDealReview: exchangeSettings.riskFirstDealReview,
        dailyLimit: exchangeSettings.riskDailyLimit,
      })
      .from(exchangeSettings)
      .where(eq(exchangeSettings.tenantId, tenantId))
      .limit(1);

    const amountThreshold = s?.amountThreshold ?? null;
    const firstDealReview = s?.firstDealReview ?? false;
    const dailyLimit = s?.dailyLimit ?? null;
    const out: string[] = [];

    if (amountThreshold && amountThreshold > 0 && input.amountToThb > amountThreshold) {
      out.push(
        `Сумма ${Math.round(input.amountToThb)} выше порога ручной проверки ${amountThreshold}.`,
      );
    }

    const needHistory =
      input.contactId != null && (firstDealReview || (dailyLimit != null && dailyLimit > 0));
    if (needHistory) {
      const orders = await tx
        .select({
          amountToThb: exchangeOrders.amountToThb,
          status: exchangeOrders.status,
          createdAt: exchangeOrders.createdAt,
        })
        .from(exchangeOrders)
        .where(
          and(
            eq(exchangeOrders.tenantId, tenantId),
            eq(exchangeOrders.contactId, input.contactId as number),
          ),
        );

      if (firstDealReview && !orders.some((o) => o.status === "completed")) {
        out.push("Первая сделка клиента (нет завершённых заявок).");
      }

      if (dailyLimit != null && dailyLimit > 0) {
        const now = input.now ?? Math.floor(Date.now() / 1000);
        const since = now - 24 * 3600;
        const sum24 = orders
          .filter((o) => DAILY_COUNTED_STATUSES.has(o.status) && (o.createdAt ?? 0) >= since)
          .reduce((acc, o) => acc + (o.amountToThb ?? 0), 0);
        if (sum24 + input.amountToThb > dailyLimit) {
          out.push(
            `Суточный объём ${Math.round(sum24 + input.amountToThb)} выше лимита ${dailyLimit}.`,
          );
        }
      }
    }

    return out;
  });
}
