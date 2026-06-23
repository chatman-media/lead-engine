import type { QuestionnaireSchema } from "@chatman-media/verticals";

export const SCOOTER_INTAKE_INTRO = `Привет! 🏍 Подберём байк под ваш запрос.

Скажите несколько слов:

1. Какой байк нужен? (авто / механика / конкретная модель)
2. Даты аренды (с / по)
3. Нужна ли доставка? Если да — куда
4. Есть водительские права? (категория A или A1)

Отвечайте в удобном формате, разберёмся быстро 🤙`;

export const SCOOTER_INTAKE_COMPLETION =
  "Готово! Подтверждаю бронирование — пришлю детали и реквизиты для депозита.";

export const SCOOTER_INTAKE: QuestionnaireSchema = {
  stageSlug: "inquiry",
  introMessage: SCOOTER_INTAKE_INTRO,
  completionMessage: SCOOTER_INTAKE_COMPLETION,
  fields: [
    {
      slug: "bike_type",
      question: "Тип байка / модель",
      kind: "enum",
      required: true,
      options: [
        "Honda Click 125",
        "Honda PCX 150",
        "Yamaha NMAX 155",
        "Honda CB500",
        "Kawasaki Z400",
        "Любой автомат",
        "Любой механика",
      ],
      hint: "автомат или механика, мощность, бренд",
    },
    {
      slug: "date_from",
      question: "Дата начала аренды",
      kind: "date",
      required: true,
    },
    {
      slug: "date_to",
      question: "Дата окончания аренды",
      kind: "date",
      required: true,
    },
    {
      slug: "delivery_needed",
      question: "Нужна ли доставка байка?",
      kind: "yesno",
      required: false,
    },
    {
      slug: "delivery_address",
      question: "Адрес доставки",
      kind: "text",
      required: false,
      hint: "отель, район, адрес",
    },
    {
      slug: "has_license",
      question: "Есть водительские права категории A / A1?",
      kind: "yesno",
      required: true,
      hint: "для байков до 125cc — A1, свыше — категория A",
    },
    {
      slug: "insurance_preferred",
      question: "Нужна ли страховка байка?",
      kind: "yesno",
      required: false,
    },
  ],
};
