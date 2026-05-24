import type { QuestionnaireSchema } from "@chatman-media/verticals";

export const REAL_ESTATE_INTAKE: QuestionnaireSchema = {
  stageSlug: "qualification",
  introMessage:
    "Привет! Чтобы подобрать подходящие варианты, мне нужно несколько минут — " +
    "задам пару вопросов о ваших предпочтениях. Начнём?",
  completionMessage:
    "Отлично, анкета заполнена! Подбираю варианты под ваши параметры и скоро напишу.",
  fields: [
    {
      slug: "budget_usd",
      question: "Какой бюджет на покупку? (в USD или AED)",
      kind: "number",
      required: true,
      hint: "Общий бюджет покупателя в USD. Если указан в AED — перевести (1 USD ≈ 3.67 AED).",
    },
    {
      slug: "property_type",
      question: "Какой тип недвижимости вас интересует?",
      kind: "enum",
      required: true,
      options: ["Квартира", "Вилла", "Таунхаус", "Студия", "Пентхаус", "Коммерческая"],
      hint: "Тип объекта: квартира, вилла, таунхаус, студия, пентхаус, коммерческая.",
    },
    {
      slug: "bedrooms",
      question: "Сколько спален нужно?",
      kind: "enum",
      required: false,
      options: ["Студия", "1", "2", "3", "4+"],
      hint: "Количество спален или «студия».",
    },
    {
      slug: "locations",
      question: "Какие районы рассматриваете? (Downtown, Marina, Palm, JVC, Business Bay...)",
      kind: "text",
      required: false,
      hint: "Предпочтительные районы Дубая. Может быть несколько.",
    },
    {
      slug: "payment_method",
      question: "Как планируете оплачивать — наличными, ипотека или рассрочка от застройщика?",
      kind: "enum",
      required: true,
      options: ["Наличные", "Ипотека", "Рассрочка от застройщика"],
      hint: "Способ оплаты: cash, mortgage или installment plan.",
    },
    {
      slug: "market_type",
      question: "Интересует первичная (от застройщика) или вторичная недвижимость (resale)?",
      kind: "enum",
      required: false,
      options: ["Первичная (от застройщика)", "Вторичная (resale)", "Оба варианта"],
      hint: "primary — новостройка, secondary — вторичный рынок.",
    },
    {
      slug: "residency_goal",
      question: "Какова цель покупки — для себя, инвестиция/аренда или виза резидента?",
      kind: "enum",
      required: false,
      options: ["Для себя", "Инвестиция / аренда", "Для получения визы резидента"],
      hint: "own_use, investment/rental yield, или получение UAE resident visa.",
    },
    {
      slug: "contact_name",
      question: "Как вас зовут?",
      kind: "text",
      required: true,
      hint: "Имя покупателя.",
    },
    {
      slug: "contact_phone",
      question: "Укажите номер телефона для связи.",
      kind: "phone",
      required: true,
      hint: "Телефон для связи с брокером.",
    },
  ],
};
