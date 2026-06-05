import type { QuestionnaireSchema } from "@chatman-media/verticals";

/**
 * Первичный intake консьержа: один свободный вход «чем помочь?». Бот
 * классифицирует запрос в тип (request_type) — он выбирает ветку воронки —
 * и фиксирует краткое описание. Цены/курсы/сроки здесь НЕ запрашиваются:
 * они приходят на стадии offer от инструментов/оператора.
 */
export const CONCIERGE_INTAKE: QuestionnaireSchema = {
  stageSlug: "request_received",
  introMessage:
    "Здравствуйте! Я ваш консьерж. Помогу с обменом валюты, трансфером, заказом еды и другими услугами на вилле. Что нужно?",
  completionMessage: "Принял запрос — сейчас уточню детали.",
  fields: [
    {
      slug: "request_type",
      question: "Что вам нужно: обмен валюты, трансфер, еда или другая услуга?",
      kind: "enum",
      required: true,
      options: ["Обмен", "Трансфер", "Еда", "Другое"],
      hint: "Тип запроса гостя — выбирает ветку воронки (exchange / transfer / food / other).",
    },
    {
      slug: "summary",
      question: "Опишите запрос в двух словах.",
      kind: "longText",
      required: false,
      hint: "Свободное описание запроса для оператора.",
    },
  ],
};
