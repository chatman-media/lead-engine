import type { QuestionnaireSchema } from "@chatman-media/verticals";

export const VIDEO_INTAKE: QuestionnaireSchema = {
  stageSlug: "inquiry",
  introMessage:
    "Привет! Расскажите о вашем проекте — несколько вопросов помогут мне " +
    "понять задачу и подготовить точное предложение.",
  completionMessage:
    "Отлично, всю информацию получил! Подготовлю смету и свяжусь с вами в ближайшее время.",
  fields: [
    {
      slug: "service_type",
      question: "Какой формат съёмки/производства вас интересует?",
      kind: "enum",
      required: true,
      options: [
        "Съёмка мероприятия",
        "Корпоративное видео",
        "Reels / Shorts",
        "Фотосессия",
        "Анимация / Motion",
        "Другое",
      ],
      hint: "Тип услуги: event, corporate video, reels, photoshoot, animation.",
    },
    {
      slug: "event_date",
      question: "Есть ли фиксированная дата мероприятия или съёмки?",
      kind: "date",
      required: false,
      hint: "Дата события или желаемая дата съёмки. Если гибко — пропустить.",
    },
    {
      slug: "location",
      question: "Где будет проходить съёмка? (город, адрес или тип локации)",
      kind: "text",
      required: true,
      hint: "Город и/или адрес локации съёмки.",
    },
    {
      slug: "duration_min",
      question: "Какой хронометраж финального материала вы ожидаете? (в минутах)",
      kind: "number",
      required: false,
      hint: "Продолжительность итогового видео в минутах. Для фото — пропустить.",
    },
    {
      slug: "style_ref",
      question: "Есть ли референсы или пожелания по стилю? (ссылка, описание или примеры)",
      kind: "longText",
      required: false,
      hint: "Референсные видео/фото, описание желаемой атмосферы или стиля.",
    },
    {
      slug: "budget_usd",
      question: "Какой примерный бюджет на проект? (в USD или RUB)",
      kind: "number",
      required: false,
      hint: "Бюджет клиента. Помогает подобрать формат и команду.",
    },
    {
      slug: "contact_name",
      question: "Как вас зовут?",
      kind: "text",
      required: true,
      hint: "Имя заказчика.",
    },
    {
      slug: "contact_phone",
      question: "Номер телефона для связи?",
      kind: "phone",
      required: true,
      hint: "Телефон для связи.",
    },
  ],
};
