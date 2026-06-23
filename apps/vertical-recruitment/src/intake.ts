import type { QuestionnaireSchema } from "@chatman-media/verticals";

/**
 * Сообщение, которым бот открывает intake — оператор-curated, 15 пунктов,
 * сохраняется verbatim. Portовано из legacy codebase.
 */
export const INTAKE_INTRO_RU = `Замечательно, а теперь приступим к заполнению анкеты!

Заполните анкету:
1. Имя и фамилия (как в паспорте)
2. Возраст
3. Рост
4. Вес
5. Гражданство
6. Семейное положение (не замужем / замужем)
7. Дети (нет / есть, укажите сколько)
8. Языки и уровень (например: английский B2, базовый китайский)
9. Опыт работы за последние 2 года (кратко)
10. Дата окончания загранпаспорта (дд.мм.гггг)
11. В каком городе вы сейчас и когда готовы выезжать
12. Фотографии 6-8 обычных (в полный рост 2-3)
13. 2 любых видео
14. Фото загран паспорта
15. Видео танца на 1 минуту (главное весёлая музыка и активные импровизированные движения)

Просьба заполнить и отправить одним сообщением, спасибо 🙌🌞`;

export const INTAKE_COMPLETION =
  "Спасибо, анкета принята! Передаём дальше — скоро вернёмся с ответом.";

/**
 * QuestionnaireSchema для intake. Хук extractFields в conversation-engine
 * сравнивает извлечённые из сообщения значения с этим списком — недостающие
 * required-поля переводят кандидата обратно в intake_pending (или просьба
 * допослать конкретного пункта).
 */
export const RECRUITMENT_INTAKE: QuestionnaireSchema = {
  stageSlug: "intake_pending",
  introMessage: INTAKE_INTRO_RU,
  completionMessage: INTAKE_COMPLETION,
  fields: [
    { slug: "name", question: "Имя и фамилия (как в паспорте)", kind: "text", required: true },
    { slug: "age", question: "Возраст", kind: "number", required: true },
    { slug: "height", question: "Рост (см)", kind: "number", required: true },
    { slug: "weight", question: "Вес (кг)", kind: "number", required: true },
    { slug: "nationality", question: "Гражданство", kind: "text", required: true },
    {
      slug: "marital_status",
      question: "Семейное положение",
      kind: "enum",
      required: true,
      options: ["не замужем", "замужем", "разведена", "вдова"],
    },
    {
      slug: "children",
      question: "Дети (нет / есть — укажите сколько)",
      kind: "text",
      required: true,
    },
    { slug: "languages", question: "Языки и уровень", kind: "longText", required: true },
    {
      slug: "work_experience",
      question: "Опыт работы за последние 2 года",
      kind: "longText",
      required: false,
    },
    {
      slug: "passport_expiry",
      question: "Дата окончания загранпаспорта (дд.мм.гггг)",
      kind: "date",
      required: true,
    },
    {
      slug: "city",
      question: "В каком городе сейчас и когда готовы выезжать",
      kind: "longText",
      required: true,
    },
    {
      slug: "photos_count",
      question: "Фотографии 6-8 обычных (в полный рост 2-3)",
      kind: "photo",
      required: true,
      hint: "обычные фото (selfie/портрет), плюс 2-3 фото в полный рост",
    },
    { slug: "videos_count", question: "2 любых видео", kind: "video", required: true },
    {
      slug: "passport_photo_received",
      question: "Фото загранпаспорта",
      kind: "photo",
      required: true,
      hint: "main_id страница биометрической фотки в паспорте",
    },
    {
      slug: "dance_video_received",
      question: "Видео танца на 1 минуту",
      kind: "video",
      required: true,
      hint: "весёлая музыка, активные импровизированные движения",
    },
  ],
};
