/**
 * Риск-чек обмена (п.10 ТЗ). Детерминированные правила в коде, НЕ в промпте:
 *   - лимиты суммы (берутся из exchange_rates, проверяются ещё на этапе котировки);
 *   - дубли: уже есть открытая заявка в этой беседе;
 *   - AML-хук для адреса отправителя крипты (расширяемая заглушка).
 *
 * Результат сохраняется в exchange_orders.risk_json. ok=false НЕ создаёт заявку.
 */

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { exchangeOrders } from "@chatman-media/storage";
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
 * Риск-чек перед созданием заявки. Лимиты уже проверены в computeQuote;
 * здесь — дубли и общая вменяемость суммы.
 */
export async function assessOrderRisk(
  db: Db,
  tenantId: number,
  input: { conversationId: number; amountToThb: number },
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

  return { ok, reasons };
}
