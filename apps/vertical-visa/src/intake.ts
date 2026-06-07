import type { QuestionnaireSchema } from "@chatman-media/verticals";

export const VISA_INTAKE_INTRO = `Здравствуйте! Я помогу подобрать оптимальный маршрут оформления визы и подготовить пакет документов.

Чтобы сразу дать точный ответ, уточните, пожалуйста:

1. Ваше гражданство
2. Страна назначения и тип визы (рабочая / туристическая / студенческая / воссоединение)
3. Планируемые даты въезда
4. Уровень английского (A1–C2)
5. Опыт работы по специальности (в годах)

По одному вопросу, если не всё готово сразу — без проблем 🙂`;

export const VISA_INTAKE_COMPLETION =
  "Отлично, базовые данные получены! Следующий шаг — сбор документов. Пришлю чек-лист в следующем сообщении.";

export const VISA_INTAKE: QuestionnaireSchema = {
  stageSlug: "qualification",
  introMessage: VISA_INTAKE_INTRO,
  completionMessage: VISA_INTAKE_COMPLETION,
  fields: [
    {
      slug: "citizenship",
      question: "Гражданство (страна паспорта)",
      kind: "text",
      required: true,
      hint: "например: Россия, Казахстан, Украина",
    },
    {
      slug: "destination_country",
      question: "Страна назначения",
      kind: "text",
      required: true,
      hint: "например: ОАЭ, Таиланд, Великобритания",
    },
    {
      slug: "visa_type",
      question: "Тип визы",
      kind: "enum",
      required: true,
      options: ["Рабочая", "Туристическая", "Студенческая", "Воссоединение семьи", "Другое"],
    },
    {
      slug: "entry_date",
      question: "Планируемая дата въезда",
      kind: "date",
      required: false,
    },
    {
      slug: "english_level",
      question: "Уровень английского",
      kind: "enum",
      required: true,
      options: ["A1", "A2", "B1", "B2", "C1", "C2"],
    },
    {
      slug: "experience_years",
      question: "Опыт работы по специальности (лет)",
      kind: "number",
      required: false,
    },
    {
      slug: "passport_photo",
      question: "Фото первого разворота паспорта",
      kind: "photo",
      required: false,
      hint: "читаемо, без бликов, без обрезанных полей",
    },
  ],
};
