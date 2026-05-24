import type { QuestionnaireSchema } from "@chatman-media/verticals";

export const SAAS_INTAKE: QuestionnaireSchema = {
  stageSlug: "discovery",
  introMessage:
    "Привет! Расскажите немного о вашем бизнесе — это займёт 2-3 минуты " +
    "и поможет мне понять, подойдёт ли Lead Engine для ваших задач.",
  completionMessage:
    "Отлично, всё понял! Подготовлю информацию под ваши задачи и скоро напишу.",
  fields: [
    {
      slug: "company_name",
      question: "Как называется ваша компания?",
      kind: "text",
      required: true,
      hint: "Название компании или проекта.",
    },
    {
      slug: "industry",
      question: "В какой сфере работаете?",
      kind: "text",
      required: true,
      hint: "Отрасль: недвижимость, рекрутинг, e-commerce, образование и т.д.",
    },
    {
      slug: "team_size",
      question: "Сколько человек в команде работает с лидами?",
      kind: "enum",
      required: true,
      options: ["Только я", "2–5", "6–20", "20+"],
      hint: "Размер команды, работающей с клиентами/лидами.",
    },
    {
      slug: "monthly_lead_volume",
      question: "Сколько входящих лидов вы получаете в месяц (примерно)?",
      kind: "number",
      required: false,
      hint: "Объём входящих обращений/лидов в месяц.",
    },
    {
      slug: "current_solution",
      question: "Как сейчас обрабатываете входящие? (CRM, вручную, другой инструмент)",
      kind: "text",
      required: false,
      hint: "Текущий инструмент или процесс обработки лидов: CRM, Excel, менеджер вручную.",
    },
    {
      slug: "pain_point",
      question: "Какая главная проблема с текущим процессом?",
      kind: "longText",
      required: true,
      hint: "Основная боль: медленный отклик, потери лидов, дорогие менеджеры, etc.",
    },
    {
      slug: "contact_name",
      question: "Как вас зовут?",
      kind: "text",
      required: true,
      hint: "Имя контактного лица.",
    },
    {
      slug: "contact_role",
      question: "Какая у вас роль в компании?",
      kind: "text",
      required: false,
      hint: "Должность: CEO, директор по продажам, маркетинг-директор и т.д.",
    },
    {
      slug: "contact_phone",
      question: "Номер телефона для связи?",
      kind: "phone",
      required: true,
      hint: "Телефон для последующего контакта.",
    },
  ],
};
