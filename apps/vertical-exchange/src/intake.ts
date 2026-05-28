import type { QuestionnaireSchema } from "@chatman-media/verticals";

/**
 * Анкета первичного запроса обмена. Собирается на стадии quote_request.
 * Бот извлекает что отдаёт клиент (актив), сеть для крипты, сумму и способ
 * получения THB (офис или банкомат). Курс и реквизиты выдаются позже —
 * детерминированным сервисом / оператором, не моделью.
 */
export const EXCHANGE_INTAKE: QuestionnaireSchema = {
  stageSlug: "quote_request",
  introMessage:
    "Здравствуйте! Меняем крипту (USDT/BTC/ETH) и рублёвые переводы на тайские баты (THB). " +
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
      hint: "Актив, который клиент отдаёт. Криптовалюта или рубли (перевод по платёжной ссылке/СБП).",
    },
    {
      slug: "network",
      question: "Для USDT — в какой сети? (принимаем TRC20)",
      kind: "enum",
      required: false,
      options: ["TRC20", "ERC20", "BEP20"],
      hint: "Сеть только для крипты, обязательна для USDT. По умолчанию принимаем TRC20. Для BTC/ETH/фиата не нужна.",
    },
    {
      slug: "amount_from",
      question: "Какую сумму обмениваете?",
      kind: "number",
      required: true,
      hint: "Сумма в активе-источнике (например 335 для 335 USDT или 3100 для 3100 RUB).",
    },
    {
      slug: "payout_method",
      question: "Как удобно получить баты — в офисе по коду или наличными в банкомате (cardless)?",
      kind: "enum",
      required: false,
      options: ["Офис", "Банкомат"],
      hint: "office — получение по коду у сотрудника офиса; atm — cardless-снятие в банкомате (Kbank/Bangkok Bank/SCB). Можно уточнить позже.",
    },
  ],
};
