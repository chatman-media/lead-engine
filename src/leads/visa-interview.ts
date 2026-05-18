/**
 * Step-by-step visa-anketa interview.
 *
 * On the `submitted` ("подача на визу") stage the bot walks the candidate
 * through the English visa application one field at a time: asks a
 * question, stores the answer into `leads.visa_docs_json`, asks the next.
 * The current step is tracked by `leads.visa_interview_field` (the
 * `VisaFields` key being awaited); `null` means the interview is done.
 *
 * The ordered step list mirrors `VISA_ANKETA_TEMPLATE` in templates.ts —
 * English label + a short Russian hint, since the values must be filled
 * in English (as in the passport).
 */

import type { VisaFields } from "./visa-docs.ts";

export interface VisaInterviewStep {
  field: keyof VisaFields;
  question: string;
}

/** Sent once when the interview starts, before the first question. */
export const VISA_INTERVIEW_INTRO = `Отлично! Теперь оформляем рабочую визу — заполним анкету по пунктам.

Я буду задавать по одному вопросу — отвечайте на каждый одним сообщением. Все данные пишите на английском (латиницей), как в загранпаспорте. Если на вопрос ответа нет — просто напишите «нет».`;

/** Sent after the last field is answered. */
export const VISA_INTERVIEW_DONE = `Спасибо, данные анкеты собрали! 🌷`;

/** Ordered interview steps — one per `VisaFields` key. */
export const VISA_INTERVIEW_STEPS: readonly VisaInterviewStep[] = [
  { field: "family_name", question: "Family name — фамилия латиницей, как в загранпаспорте." },
  { field: "given_name", question: "Given name — имя латиницей, как в загранпаспорте." },
  { field: "date_of_birth", question: "Date of birth — дата рождения в формате yyyy-MM-dd." },
  {
    field: "country_of_birth",
    question: "Country / Region of birth — страна рождения (на английском).",
  },
  {
    field: "birth_province",
    question: "Province / State of birth — область или штат рождения (на английском).",
  },
  { field: "city_of_birth", question: "City of birth — город рождения (на английском)." },
  {
    field: "marital_status",
    question: "Marital status — семейное положение (single / married).",
  },
  {
    field: "current_nationality",
    question: "Current nationality — текущее гражданство (на английском).",
  },
  {
    field: "national_id_number",
    question: "National ID number — номер внутреннего паспорта.",
  },
  {
    field: "other_nationalities",
    question:
      "Do you have any other nationality(ies)? — есть ли у вас другое гражданство (yes / no, если да — укажите).",
  },
  {
    field: "other_permanent_residence",
    question:
      "Do you have permanent residence in another country or region? — есть ли ПМЖ в другой стране (yes / no).",
  },
  {
    field: "held_other_nationalities",
    question:
      "Have you ever held any other nationality(ies)? — было ли когда-либо другое гражданство (yes / no).",
  },
  {
    field: "passport_number",
    question: "Passport / travel document number — номер загранпаспорта.",
  },
  {
    field: "passport_issuing_country",
    question:
      "Passport issuing country or region — страна, выдавшая загранпаспорт (на английском).",
  },
  {
    field: "passport_issuing_place",
    question:
      "Passport issuing place — место выдачи загранпаспорта (обычно указано цифрами в паспорте).",
  },
  {
    field: "passport_expiration_date",
    question: "Passport expiration date — дата окончания загранпаспорта в формате yyyy-MM-dd.",
  },
  {
    field: "current_address",
    question: "Current residence address — адрес вашего проживания (на английском).",
  },
  { field: "phone", question: "Phone number — телефон." },
  { field: "mobile_phone", question: "Mobile phone number — мобильный телефон." },
  { field: "email", question: "Email address — электронная почта." },
  { field: "father_name", question: "Father — имя отца (на английском)." },
  { field: "father_nationality", question: "Father — гражданство отца (на английском)." },
  {
    field: "father_dob",
    question: "Father — дата рождения отца в формате yyyy-MM-dd.",
  },
  { field: "mother_name", question: "Mother — имя матери (на английском)." },
  { field: "mother_nationality", question: "Mother — гражданство матери (на английском)." },
  {
    field: "mother_dob",
    question: "Mother — дата рождения матери в формате yyyy-MM-dd.",
  },
  { field: "been_to_china", question: "Have you been to China? — были ли вы в Китае (yes / no)." },
  {
    field: "previous_chinese_visa",
    question:
      "Have you ever been issued a Chinese visa? — была ли у вас китайская виза. Если да — тип, номер, место и дата выдачи (и пришлите фото виз).",
  },
  {
    field: "work_experience",
    question:
      "Work experience — опыт работы за последние годы (можно неофициальную), в обратном хронологическом порядке. Для каждого места: даты, работодатель, его адрес и телефон, должность, имя руководителя и его телефон.",
  },
  {
    field: "education",
    question: "Education — учёба: название учебного заведения, диплом, специальность.",
  },
  {
    field: "travel_history_12mo",
    question:
      "Have you travelled to any other countries in the past 12 months? — поездки за рубеж за последние 12 месяцев.",
  },
  {
    field: "family_other",
    question:
      "Family — муж и дети (если есть): имя, фамилия, дата рождения, гражданство. Если были замужем — тоже укажите.",
  },
];

const STEP_BY_FIELD = new Map(VISA_INTERVIEW_STEPS.map((s) => [s.field as string, s]));

/** The `VisaFields` key of the first interview step. */
export function firstInterviewField(): string {
  return VISA_INTERVIEW_STEPS[0]!.field;
}

/** Question text for a given field, or `undefined` if the field is unknown. */
export function interviewQuestion(field: string): string | undefined {
  return STEP_BY_FIELD.get(field)?.question;
}

/**
 * Question text for a field, with a confirm-or-correct hint appended
 * when `docs` already carries a value for it (pre-filled from passport
 * OCR, chat extraction, or an operator edit). The candidate confirms
 * with «да» or sends a corrected value — see `isInterviewConfirmation`.
 * Returns `undefined` for an unknown field.
 */
export function interviewQuestionWithPrefill(
  field: string,
  docs: Record<string, string> | undefined,
): string | undefined {
  const question = interviewQuestion(field);
  if (!question) return undefined;
  const existing = docs?.[field]?.trim();
  if (!existing) return question;
  return (
    `${question}\n\nУ нас уже есть для этого поля: «${existing}».\n` +
    `Если всё верно — ответьте «да». Если нужно исправить — пришлите правильное значение.`
  );
}

/**
 * True when the candidate's reply is a plain confirmation of a
 * pre-filled interview field (rather than a corrected value).
 */
export function isInterviewConfirmation(text: string): boolean {
  return /^(да|верно|ок|окей|yes|y|ok|правильно|корректно|всё верно|все верно)$/i.test(text.trim());
}

/** The field that follows `current`, or `null` when `current` is the last
 *  step (or is not a known step). */
export function nextInterviewField(current: string): string | null {
  const idx = VISA_INTERVIEW_STEPS.findIndex((s) => s.field === current);
  if (idx === -1 || idx + 1 >= VISA_INTERVIEW_STEPS.length) return null;
  return VISA_INTERVIEW_STEPS[idx + 1]!.field;
}
