import type { QuestionnaireSchema } from "@chatman-media/verticals";

/**
 * Анкета первичного запроса обмена. Собирается на стадии quote_request.
 * Бот извлекает что отдаёт клиент (актив + способ оплаты), сеть для крипты
 * и сумму. Курс и реквизиты выдаются позже — оператором/из настроек.
 */
export const EXCHANGE_INTAKE: QuestionnaireSchema = {
  stageSlug: "quote_request",
  introMessage:
    "Здравствуйте! Меняем крипту, рублёвые переводы и наличные на THB. " +
    "Что хотите обменять и на какую сумму?",
  completionMessage:
    "Принято! Сейчас подтвердим курс и итоговую сумму в батах.",
  fields: [
    {
      slug: "asset_from",
      question: "Что отдаёте — USDT, BTC, ETH, рубли, EUR или USD?",
      kind: "enum",
      required: true,
      options: ["USDT", "BTC", "ETH", "RUB", "EUR", "USD"],
      hint: "Актив, который клиент отдаёт. Криптовалюта, рубли (перевод на карту) или фиат наличными.",
    },
    {
      slug: "payment_method",
      question: "Как будете оплачивать — крипта, перевод в рублях или наличные?",
      kind: "enum",
      required: true,
      options: ["Крипта", "Перевод в рублях", "Наличные"],
      hint: "crypto — перевод на кошелёк; rub_transfer — перевод на карту Сбер/Тинькофф; cash — наличные.",
    },
    {
      slug: "network",
      question: "Для USDT — в какой сети? (TRC20, ERC20 или BEP20)",
      kind: "enum",
      required: false,
      options: ["TRC20", "ERC20", "BEP20"],
      hint: "Сеть только для крипты, обязательна для USDT. Для BTC/ETH/фиата не нужна.",
    },
    {
      slug: "amount_from",
      question: "Какую сумму обмениваете?",
      kind: "number",
      required: true,
      hint: "Сумма в активе-источнике (например 500 для 500 USDT или 40000 для 40000 RUB).",
    },
  ],
};
