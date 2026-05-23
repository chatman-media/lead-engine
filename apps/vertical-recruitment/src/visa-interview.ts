/**
 * Step-by-step visa interview для recruitment воронки. После
 * intake_complete → approved → docs_complete → visa_form кандидата ведут
 * по этим вопросам последовательно. Ответы пишутся в leads.visa_docs_json.
 *
 * Ported из legacy codebase. Поля совпадают
 * с VisaFields там — формат yyyy-MM-dd для дат, латиница для имён.
 */

import type { QuestionnaireField } from "@chatman-media/verticals";

export const VISA_INTERVIEW_INTRO = `Отлично! Теперь оформляем рабочую визу — заполним анкету по пунктам.

Я буду задавать по одному вопросу — отвечайте на каждый одним сообщением. Все данные пишите на английском (латиницей), как в загранпаспорте. Если на вопрос ответа нет — просто напишите «нет».`;

export const VISA_INTERVIEW_DONE = "Спасибо, данные анкеты собрали! 🌷";

export const RECRUITMENT_VISA_INTERVIEW: readonly QuestionnaireField[] = [
  {
    slug: "visa_application_city",
    question:
      "В каком городе вам удобно подать документы на визу? Ближайшие китайские консульства: Санкт-Петербург, Екатеринбург, Иркутск, Хабаровск, Владивосток. Напишите название города по-русски. Если в вашем городе есть китайский визовый центр — напишите его.",
    kind: "text",
    required: true,
  },
  { slug: "family_name", question: "Family name — фамилия латиницей, как в загранпаспорте.", kind: "text", required: true },
  { slug: "given_name", question: "Given name — имя латиницей, как в загранпаспорте.", kind: "text", required: true },
  { slug: "date_of_birth", question: "Date of birth — дата рождения в формате yyyy-MM-dd.", kind: "date", required: true },
  { slug: "country_of_birth", question: "Country / Region of birth — страна рождения (на английском).", kind: "text", required: true },
  { slug: "birth_province", question: "Province / State of birth — область или штат рождения (на английском).", kind: "text", required: true },
  { slug: "city_of_birth", question: "City of birth — город рождения (на английском).", kind: "text", required: true },
  {
    slug: "marital_status",
    question: "Marital status — семейное положение (single / married).",
    kind: "enum",
    required: true,
    options: ["single", "married", "divorced", "widowed"],
  },
  { slug: "current_nationality", question: "Current nationality — текущее гражданство (на английском).", kind: "text", required: true },
  { slug: "national_id_number", question: "National ID number — номер внутреннего паспорта.", kind: "text", required: true },
  {
    slug: "other_nationalities",
    question:
      "Do you have any other nationality(ies)? — есть ли у вас другое гражданство (yes / no, если да — укажите).",
    kind: "text",
    required: false,
  },
  {
    slug: "other_permanent_residence",
    question:
      "Do you have permanent residence in another country or region? — есть ли ПМЖ в другой стране (yes / no).",
    kind: "yesno",
    required: false,
  },
  {
    slug: "held_other_nationalities",
    question:
      "Have you ever held any other nationality(ies)? — было ли когда-либо другое гражданство (yes / no).",
    kind: "yesno",
    required: false,
  },
  { slug: "passport_number", question: "Passport / travel document number — номер загранпаспорта.", kind: "text", required: true },
  {
    slug: "passport_issuing_country",
    question: "Passport issuing country or region — страна, выдавшая загранпаспорт (на английском).",
    kind: "text",
    required: true,
  },
  {
    slug: "passport_issuing_place",
    question:
      "Passport issuing place — место выдачи загранпаспорта (обычно указано цифрами в паспорте).",
    kind: "text",
    required: true,
  },
  {
    slug: "passport_expiration_date",
    question: "Passport expiration date — дата окончания загранпаспорта в формате yyyy-MM-dd.",
    kind: "date",
    required: true,
  },
  { slug: "current_address", question: "Current residence address — адрес вашего проживания (на английском).", kind: "longText", required: true },
  { slug: "phone", question: "Phone number — телефон.", kind: "phone", required: false },
  { slug: "mobile_phone", question: "Mobile phone number — мобильный телефон.", kind: "phone", required: true },
  { slug: "email", question: "Email address — электронная почта.", kind: "email", required: true },
  { slug: "father_name", question: "Father — имя отца (на английском).", kind: "text", required: true },
  { slug: "father_nationality", question: "Father — гражданство отца (на английском).", kind: "text", required: true },
  { slug: "father_dob", question: "Father — дата рождения отца в формате yyyy-MM-dd.", kind: "date", required: false },
  { slug: "mother_name", question: "Mother — имя матери (на английском).", kind: "text", required: true },
  { slug: "mother_nationality", question: "Mother — гражданство матери (на английском).", kind: "text", required: true },
  { slug: "mother_dob", question: "Mother — дата рождения матери в формате yyyy-MM-dd.", kind: "date", required: false },
  {
    slug: "been_to_china",
    question: "Have you been to China? — были ли вы в Китае (yes / no).",
    kind: "yesno",
    required: true,
  },
  {
    slug: "previous_chinese_visa",
    question:
      "Have you ever been issued a Chinese visa? — была ли у вас китайская виза. Если да — тип, номер, место и дата выдачи (и пришлите фото виз).",
    kind: "longText",
    required: false,
  },
  {
    slug: "work_experience",
    question:
      "Work experience — опыт работы за последние годы (можно неофициальную), в обратном хронологическом порядке. Для каждого места: даты, работодатель, его адрес и телефон, должность, имя руководителя и его телефон.",
    kind: "longText",
    required: false,
  },
  {
    slug: "education",
    question: "Education — учёба: название учебного заведения, диплом, специальность.",
    kind: "longText",
    required: false,
  },
  {
    slug: "travel_history_12mo",
    question:
      "Have you travelled to any other countries in the past 12 months? — поездки за рубеж за последние 12 месяцев.",
    kind: "longText",
    required: false,
  },
  {
    slug: "family_other",
    question:
      "Family — муж и дети (если есть): имя, фамилия, дата рождения, гражданство. Если были замужем — тоже укажите.",
    kind: "longText",
    required: false,
  },
];
