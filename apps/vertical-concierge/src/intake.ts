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
    "Здравствуйте! Я ваш консьерж на вилле. Помогу с:\n" +
    "• Обмен валюты\n" +
    "• Трансфер\n" +
    "• Еда\n" +
    "• Уборка\n" +
    "• Экскурсии и туры\n" +
    "• Другие услуги\n" +
    "Что нужно?",
  completionMessage: "Принял запрос — сейчас уточню детали.",
  fields: [
    {
      slug: "request_type",
      question:
        "Что вам нужно: обмен валюты, трансфер, еда, уборка, экскурсия или другая услуга?",
      kind: "enum",
      required: true,
      options: ["Обмен", "Трансфер", "Еда", "Уборка", "Экскурсия", "Другое"],
      hint: "Тип запроса гостя — выбирает ветку воронки (exchange / transfer / food / housekeeping / tour / other).",
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
