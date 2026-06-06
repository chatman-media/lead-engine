/**
 * Авто-оценка качества exchange-диалога. Берёт уже проведённый диалог
 * (self_play или реальный) и проверяет, довёл ли бот клиента по сквозному
 * потоку: понял запрос → дал курс → выдал реквизиты → (в идеале) дошёл до кода
 * выдачи, и при этом НЕ сбежал к оператору раньше времени.
 *
 * Сигналы детектятся двумя путями — по тексту реплик бота И по состоянию
 * заявки (exchange_orders) — чтобы оценка работала и в живом прогоне с
 * реальными инструментами, и в тестах с моками reply-стратегии.
 */
import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { exchangeOrders, messages } from "@chatman-media/storage";
import { and, asc, eq } from "drizzle-orm";

export interface ExchangeDialogSignals {
  reachedQuote: boolean;
  requisitesIssued: boolean;
  payoutDelivered: boolean;
  /** Бот ушёл к оператору/«уточню» ДО того, как дал курс — преждевременно. */
  prematureOperator: boolean;
  orderStatus: string | null;
  assistantTurns: number;
}

export interface ExchangeDialogScore {
  conversationId: number;
  passed: boolean;
  signals: ExchangeDialogSignals;
  reasons: string[];
}

const RE_QUOTE = /курс|rate|\b\d[\d\s.,]*\s?(?:thb|бат|฿)/i;
const RE_REQUISITES = /реквизит|адрес|кошел|trc20|erc20|bep20|сбп|qr|карт[аеуы]|счёт|счет/i;
const RE_PAYOUT = /код выдачи|код получени|payout|код снят/i;
const RE_OPERATOR = /оператор|менеджер|уточн(?:ю|им)|свяж|переключ|партнёр|партнер|перезвон/i;

/** Оценивает диалог обмена по conversationId. Тянет реплики бота + заявку. */
export async function scoreExchangeDialog(
  db: Db,
  tenantId: number,
  conversationId: number,
): Promise<ExchangeDialogScore> {
  const { botTexts, order } = await withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ role: messages.role, text: messages.text, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId)))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const [ord] = await tx
      .select({
        status: exchangeOrders.status,
        requisitesJson: exchangeOrders.requisitesJson,
        payoutCode: exchangeOrders.payoutCode,
      })
      .from(exchangeOrders)
      .where(and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.conversationId, conversationId)))
      .orderBy(asc(exchangeOrders.id))
      .limit(1);
    return {
      botTexts: rows.filter((r) => r.role === "assistant").map((r) => r.text ?? ""),
      order: ord ?? null,
    };
  });

  const statusBeyondQuote =
    order != null && ["awaiting_payment", "paid", "payout", "completed"].includes(order.status);

  let reachedQuote = statusBeyondQuote;
  let firstOperatorIdx = -1;
  let firstQuoteIdx = -1;
  botTexts.forEach((text, i) => {
    if (firstQuoteIdx === -1 && RE_QUOTE.test(text)) firstQuoteIdx = i;
    if (firstOperatorIdx === -1 && RE_OPERATOR.test(text)) firstOperatorIdx = i;
    if (RE_QUOTE.test(text)) reachedQuote = true;
  });

  const requisitesIssued =
    (order?.requisitesJson != null && order.requisitesJson.length > 0) ||
    botTexts.some((t) => RE_REQUISITES.test(t));
  const payoutDelivered =
    (order?.payoutCode != null && order.payoutCode.length > 0) ||
    order?.status === "completed" ||
    botTexts.some((t) => RE_PAYOUT.test(t));

  // Преждевременный оператор: бот сослался на оператора раньше, чем дал курс
  // (или курс так и не прозвучал, а к оператору ушёл).
  const prematureOperator =
    firstOperatorIdx !== -1 && (firstQuoteIdx === -1 || firstOperatorIdx < firstQuoteIdx);

  const reasons: string[] = [];
  if (!reachedQuote) reasons.push("бот не дал курс");
  if (!requisitesIssued) reasons.push("реквизиты не выданы");
  if (prematureOperator) reasons.push("преждевременный уход к оператору");

  const passed = reachedQuote && requisitesIssued && !prematureOperator;

  return {
    conversationId,
    passed,
    reasons,
    signals: {
      reachedQuote,
      requisitesIssued,
      payoutDelivered,
      prematureOperator,
      orderStatus: order?.status ?? null,
      assistantTurns: botTexts.length,
    },
  };
}
