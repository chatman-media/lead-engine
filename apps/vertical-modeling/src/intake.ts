import type { QuestionnaireSchema } from "@chatman-media/verticals";

/**
 * Приветствие на входе в анкету модельного агентства.
 * Бот зачитывает его первым сообщением на intake-стадии.
 */
export const MODELING_INTAKE_INTRO = `Привет! Рада видеть тебя здесь 🌟

Чтобы познакомиться и оценить твои данные, заполни, пожалуйста, небольшую анкету. Заполни одним сообщением:

1. Имя и фамилия
2. Возраст
3. Рост / вес
4. Город (где сейчас)
5. Опыт в модельном бизнесе (если есть — кратко)
6. Instagram или ссылка на портфолио (если есть)
7. 3–5 фотографий: одно лицо крупным планом + одно в полный рост
8. Короткое видео-представление: 30–60 сек, расскажи о себе

Всё в одном сообщении — спасибо! 🙏`;

export const MODELING_INTAKE_COMPLETION =
  "Отлично, анкета принята! Передаём твои данные кастинг-директору — ответим в течение 2–3 дней.";

/**
 * Questionnaire для intake модельной воронки.
 * field-extractor вычитывает поля из текста/медиа кандидата
 * и помечает stage complete когда все required собраны.
 */
export const MODELING_INTAKE: QuestionnaireSchema = {
  stageSlug: "intake_pending",
  introMessage: MODELING_INTAKE_INTRO,
  completionMessage: MODELING_INTAKE_COMPLETION,
  fields: [
    { slug: "name", question: "Имя и фамилия", kind: "text", required: true },
    { slug: "age", question: "Возраст", kind: "number", required: true },
    { slug: "height", question: "Рост (см)", kind: "number", required: true },
    { slug: "weight", question: "Вес (кг)", kind: "number", required: false },
    { slug: "city", question: "Город (где сейчас)", kind: "text", required: true },
    {
      slug: "experience",
      question: "Опыт в модельном бизнесе",
      kind: "longText",
      required: false,
    },
    {
      slug: "portfolio_link",
      question: "Instagram или ссылка на портфолио",
      kind: "text",
      required: false,
    },
    {
      slug: "photos_received",
      question: "Фотографии (лицо + полный рост)",
      kind: "photo",
      required: true,
      hint: "минимум 2 фото: одно лицо крупным планом, одно в полный рост",
    },
    {
      slug: "intro_video_received",
      question: "Видео-представление 30–60 сек",
      kind: "video",
      required: true,
      hint: "расскажи о себе, покажи внешность и харизму",
    },
  ],
};
