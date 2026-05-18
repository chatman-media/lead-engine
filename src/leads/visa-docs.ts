import { log } from "../log.ts";
import type { ChatClient, ChatMessage } from "../rag/chat.ts";
import type { InternalPassportIdentity, PassportIdentity } from "../rag/vision.ts";

/**
 * Subset of the visa-application form (templates.ts VISA_ANKETA_TEMPLATE)
 * that the LLM extractor pulls out of candidate messages and accumulates
 * in `leads.visa_docs_json`.
 *
 * Why a SUBSET (not all 40 fields): single-shot extraction of huge
 * schemas is fragile (models miss / hallucinate / mis-attribute), and
 * the operator has to verify everything before consulate submission
 * anyway. We pull the high-signal fields the operator scans first
 * (name + DOB + passport + contact + parents + China history) and
 * keep the rest as free-form fields the operator pastes from chat
 * verbatim. The schema can be widened later without DB migration —
 * `leads.visa_docs_json` is opaque JSON.
 *
 * All fields are optional. The extractor only writes fields it found
 * in the candidate's reply; previous values survive when not mentioned
 * again.
 */
export interface VisaFields {
  // Identity
  family_name?: string;
  given_name?: string;
  date_of_birth?: string;
  country_of_birth?: string;
  birth_province?: string;
  city_of_birth?: string;
  marital_status?: string;
  current_nationality?: string;
  national_id_number?: string;
  other_nationalities?: string;
  other_permanent_residence?: string;
  held_other_nationalities?: string;

  // Passport
  passport_number?: string;
  passport_issuing_country?: string;
  passport_issuing_place?: string;
  passport_expiration_date?: string;

  // Contact
  current_address?: string;
  phone?: string;
  mobile_phone?: string;
  email?: string;

  // Family — flat fields keep extraction prompt small. Full structured
  // entries (siblings, spouse, kids) go into the free-form block.
  father_name?: string;
  father_nationality?: string;
  father_dob?: string;
  mother_name?: string;
  mother_nationality?: string;
  mother_dob?: string;

  // China history — yes/no with optional details. Operator reads chat
  // for the prior visa specifics if needed.
  been_to_china?: string;
  previous_chinese_visa?: string;

  // Open-ended fields the LLM can capture as paragraphs without forcing
  // sub-schemas. The operator pastes / edits them inline if needed.
  work_experience?: string;
  education?: string;
  travel_history_12mo?: string;
  family_other?: string;
}

/**
 * Field labels for UI. Keys must match VisaFields. New fields must
 * appear here so the admin's progress strip and edit form have a
 * label.
 */
export const VISA_FIELD_LABELS: Record<keyof VisaFields, string> = {
  family_name: "Family name",
  given_name: "Given name",
  date_of_birth: "Date of birth",
  country_of_birth: "Country of birth",
  birth_province: "Birth province / state",
  city_of_birth: "City of birth",
  marital_status: "Marital status",
  current_nationality: "Current nationality",
  national_id_number: "National ID number",
  other_nationalities: "Other nationality(ies)",
  other_permanent_residence: "Permanent residence elsewhere",
  held_other_nationalities: "Previously held nationality(ies)",
  passport_number: "Passport number",
  passport_issuing_country: "Passport issuing country",
  passport_issuing_place: "Passport issuing place",
  passport_expiration_date: "Passport expiration",
  current_address: "Current address",
  phone: "Phone",
  mobile_phone: "Mobile phone",
  email: "Email",
  father_name: "Father name",
  father_nationality: "Father nationality",
  father_dob: "Father DOB",
  mother_name: "Mother name",
  mother_nationality: "Mother nationality",
  mother_dob: "Mother DOB",
  been_to_china: "Been to China?",
  previous_chinese_visa: "Previous Chinese visa",
  work_experience: "Work experience",
  education: "Education",
  travel_history_12mo: "Travel last 12mo",
  family_other: "Spouse / children",
};

/**
 * Fields the operator considers must-haves before submitting on the
 * consulate side. Used by `visaDocsCompleteness` to compute a percent
 * + missing-list for UI progress.
 */
export const VISA_REQUIRED_FIELDS: ReadonlyArray<keyof VisaFields> = [
  "family_name",
  "given_name",
  "date_of_birth",
  "country_of_birth",
  "birth_province",
  "city_of_birth",
  "marital_status",
  "current_nationality",
  "national_id_number",
  "passport_number",
  "passport_issuing_country",
  "passport_expiration_date",
  "current_address",
  "phone",
  "email",
  "father_name",
  "mother_name",
  "been_to_china",
];

const SYSTEM_PROMPT = `Ты извлекаешь данные визовой анкеты из переписки рекрутингового агентства.

Анкета на английском (Family name, Given name, Date of birth, Country/Province/City of birth, Marital status, Current nationality, National ID, other nationality / permanent residence questions, Passport number / issuing country / place / expiration, Address, Phone, Mobile phone, Email, Father+Mother (name/nationality/DOB), Have you been to China?, Previous Chinese visa, Work experience, Education, Travel history past 12 months, Family).

Извлекай ТОЛЬКО то, что девушка явно написала. Никаких догадок.

Возвращаемые поля (все опциональные):
- family_name, given_name, date_of_birth (yyyy-mm-dd если возможно)
- country_of_birth, birth_province (область/штат рождения), city_of_birth
- marital_status (single / married / divorced / ...)
- current_nationality
- national_id_number
- other_nationalities (есть ли другое гражданство — yes/no + детали)
- other_permanent_residence (ПМЖ в другой стране — yes/no + детали)
- held_other_nationalities (было ли когда-либо другое гражданство — yes/no + детали)
- passport_number, passport_issuing_country, passport_issuing_place, passport_expiration_date
- current_address, phone (домашний/общий телефон), mobile_phone (мобильный телефон), email
- father_name, father_nationality, father_dob
- mother_name, mother_nationality, mother_dob
- been_to_china (yes / no), previous_chinese_visa (опиши коротко если есть)
- work_experience (свободный текст: даты + работодатель + позиция)
- education (institution / diploma / major)
- travel_history_12mo (страны куда ездила за 12 месяцев)
- family_other (муж / дети / прошлые браки если упомянуто)

ВЕРНИ СТРОГО JSON-объект. Без markdown, без \`\`\`, без комментариев.
Если поле не упомянуто — НЕ включай его в JSON.
Если поле уже есть в "Существующие" и не изменилось — НЕ повторяй.

Только новые / обновлённые поля.`;

export interface ExtractVisaInput {
  /** Recent messages, oldest first, role + content. */
  messages: ChatMessage[];
  /** Existing fields so the LLM can skip what's already known. */
  existingDocs?: VisaFields;
  chat: ChatClient;
}

/**
 * Calls the LLM extractor. Returns the merged VisaFields (existing +
 * newly-extracted, with new values winning). Falls back to existing
 * unchanged on LLM errors.
 */
export async function extractVisaDocs(input: ExtractVisaInput): Promise<VisaFields> {
  const userMessages = input.messages.filter((m) => m.role === "user");
  const merged: VisaFields = { ...(input.existingDocs ?? {}) };
  if (userMessages.length === 0) return merged;

  const conversation = input.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const existingJson = JSON.stringify(input.existingDocs ?? {});

  let raw: string;
  try {
    raw = await input.chat.complete(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Сообщения:\n${conversation}\n\nСуществующие: ${existingJson}\n\nОтвет:`,
        },
      ],
      { temperature: 0.1 },
    );
  } catch (err) {
    log.error("visa-docs LLM extract failed", { scope: "visa-docs", err });
    return merged;
  }

  const extracted = parseVisaDocsJson(raw);
  return { ...merged, ...extracted };
}

const ALL_FIELDS: ReadonlyArray<keyof VisaFields> = Object.keys(VISA_FIELD_LABELS) as Array<
  keyof VisaFields
>;

const MAX_FIELD_LEN = 1500;

/**
 * Parses the LLM's JSON output. Drops non-string values, oversized
 * strings, and unknown keys. Exported for unit tests.
 */
export function parseVisaDocsJson(raw: string): Partial<VisaFields> {
  let s = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/```(?:json)?/gi, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const out: Partial<VisaFields> = {};
  for (const key of ALL_FIELDS) {
    const val = obj[key];
    if (typeof val !== "string") continue;
    const trimmed = val.trim();
    if (!trimmed || trimmed.length > MAX_FIELD_LEN) continue;
    out[key] = trimmed;
  }
  return out;
}

const INTERVIEW_INTERPRET_PROMPT = `Ты помогаешь заполнять визовую анкету. Девушке задали ОДИН вопрос анкеты, и она прислала сообщение. Твоя задача — понять, что именно она ответила.

Тебе дают: ключ текущего поля, текст вопроса, список всех полей анкеты, уже заполненные поля и сообщение девушки.

Правила:
- Извлекай ТОЛЬКО значения, которые девушка ЯВНО написала в этом сообщении. Никаких догадок.
- Обычно ответ относится к ТЕКУЩЕМУ полю — помести значение в patch под ключом текущего поля.
- Если девушка явно указывает, что значение относится к ДРУГОМУ полю («это фамилия, а не имя», «перепутала», «имя — X, фамилия — Y»), помести каждое значение под ПРАВИЛЬНЫМ ключом. При необходимости так исправляется ранее заполненное поле.
- Не исправляй ранее заполненные поля, если девушка явно об этом не просит.
- answered_current = true, только если сообщение содержит значение для текущего поля. Ответ «нет»/«no» — валидное значение для многих полей: считай его ответом (answered_current = true, в patch текущее поле = "no").
- off_topic = true, если сообщение — это вопрос или болтовня, а не ответ на анкету. Тогда patch пустой, answered_current = false.
- Даты по возможности приводи к формату yyyy-MM-dd.
- Имена и значения для визы пиши латиницей, ровно как написала девушка; ничего не транслитерируй сам.

ВЕРНИ СТРОГО JSON, без markdown, без \`\`\`, без комментариев:
{"patch": {"<field>": "<value>", ...}, "answered_current": true|false, "off_topic": true|false}`;

/** Outcome of interpreting a single interview answer. */
export interface InterviewInterpretation {
  /** Fields to set / correct (may include fields other than the current one). */
  patch: Partial<VisaFields>;
  /** True when the message carried a value for the current field. */
  answeredCurrent: boolean;
  /** True when the message was a question / chit-chat, not an answer. */
  offTopic: boolean;
  /** True when the LLM could not be used — caller falls back to verbatim store. */
  llmFailed: boolean;
}

export interface InterpretInterviewInput {
  /** The `VisaFields` key being awaited. */
  currentField: keyof VisaFields;
  /** The question text shown to the candidate. */
  question: string;
  /** The candidate's raw reply (already trimmed). */
  userMessage: string;
  /** Accumulated answers so far — context for cross-field corrections. */
  existingDocs: VisaFields;
  chat: ChatClient;
}

/**
 * Interprets a candidate's interview reply via the LLM: turns free-text
 * ("перепутала, Alexandra имя, Kireeva фамилия") into a structured
 * `VisaFields` patch and flags whether the current field was answered.
 * Any LLM / parse failure returns `llmFailed: true` so the caller can
 * fall back to the legacy verbatim-store behaviour — the interview must
 * never break.
 */
export async function interpretInterviewAnswer(
  input: InterpretInterviewInput,
): Promise<InterviewInterpretation> {
  const fieldList = ALL_FIELDS.map((k) => `- ${k}: ${VISA_FIELD_LABELS[k]}`).join("\n");
  const userContent =
    `Текущее поле: ${input.currentField} ("${input.question}")\n\n` +
    `Все поля анкеты:\n${fieldList}\n\n` +
    `Уже заполнено: ${JSON.stringify(input.existingDocs)}\n\n` +
    `Сообщение девушки:\n${input.userMessage}\n\nОтвет:`;

  let raw: string;
  try {
    raw = await input.chat.complete(
      [
        { role: "system", content: INTERVIEW_INTERPRET_PROMPT },
        { role: "user", content: userContent },
      ],
      { temperature: 0.1 },
    );
  } catch (err) {
    log.error("visa interview interpret failed", { scope: "visa-docs", err });
    return { patch: {}, answeredCurrent: false, offTopic: false, llmFailed: true };
  }

  return parseInterpretResult(raw, input.currentField, input.userMessage);
}

/** Normalises text for the hallucination-guard substring check. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Parses the interpreter's JSON. Drops unknown / non-string / oversized
 * patch values. Hallucination guard: a value for a field OTHER than the
 * current one is kept only when it actually appears in the candidate's
 * message (the current field is exempt — it may be normalised, e.g. a
 * date). Returns `llmFailed: true` on garbage, or when the result is
 * internally inconsistent (claims the current field was answered but
 * carries no value for it), so the caller falls back to verbatim store.
 * Exported for unit tests.
 */
export function parseInterpretResult(
  raw: string,
  currentField: keyof VisaFields,
  userMessage: string,
): InterviewInterpretation {
  const failed: InterviewInterpretation = {
    patch: {},
    answeredCurrent: false,
    offTopic: false,
    llmFailed: true,
  };

  let s = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/```(?:json)?/gi, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return failed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return failed;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return failed;
  const obj = parsed as Record<string, unknown>;

  const patchRaw =
    typeof obj.patch === "object" && obj.patch !== null && !Array.isArray(obj.patch)
      ? (obj.patch as Record<string, unknown>)
      : {};
  const haystack = normalizeForMatch(userMessage);
  const patch: Partial<VisaFields> = {};
  for (const key of ALL_FIELDS) {
    const val = patchRaw[key];
    if (typeof val !== "string") continue;
    const trimmed = val.trim();
    if (!trimmed || trimmed.length > MAX_FIELD_LEN) continue;
    if (key !== currentField && !haystack.includes(normalizeForMatch(trimmed))) continue;
    patch[key] = trimmed;
  }

  const offTopic = obj.off_topic === true;
  if (offTopic) return { patch, answeredCurrent: false, offTopic: true, llmFailed: false };

  const answeredCurrent = obj.answered_current === true;
  // Inconsistent: claims the current field was answered but no value for
  // it survived → fall back to verbatim store rather than advance empty.
  if (answeredCurrent && !patch[currentField]) return failed;
  // Nothing usable at all → fall back so a plain answer is never lost.
  if (!answeredCurrent && Object.keys(patch).length === 0) return failed;

  return { patch, answeredCurrent, offTopic: false, llmFailed: false };
}

/**
 * % of required fields filled + the list of still-missing keys.
 * Used by the UI progress strip and the auto-promote check.
 */
export function visaDocsCompleteness(docs: VisaFields | undefined): {
  filled: number;
  total: number;
  missing: Array<keyof VisaFields>;
} {
  const total = VISA_REQUIRED_FIELDS.length;
  if (!docs) return { filled: 0, total, missing: [...VISA_REQUIRED_FIELDS] };
  const missing: Array<keyof VisaFields> = [];
  let filled = 0;
  for (const key of VISA_REQUIRED_FIELDS) {
    const val = docs[key];
    if (typeof val === "string" && val.trim()) filled++;
    else missing.push(key);
  }
  return { filled, total, missing };
}

/**
 * Normalises a `dd.mm.yyyy` date to the `yyyy-MM-dd` form the visa
 * anketa uses. A string that doesn't match that shape (already ISO, or
 * unparseable) is returned unchanged — the operator fixes it by hand.
 */
export function toIsoDate(raw: string): string {
  const m = raw.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return raw.trim();
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Maps passport-photo OCR (`PassportIdentity`) onto visa-anketa fields.
 * Used to pre-fill `leads.visa_docs_json` before the step-by-step
 * interview starts, so identity fields the passport already carries
 * aren't collected from scratch. Dates are converted to `yyyy-MM-dd`;
 * nationality fills both the citizenship and the passport-issuing
 * country (a загранпаспорт is issued by the country of citizenship).
 */
export function passportToVisaFields(passport: PassportIdentity): Partial<VisaFields> {
  const out: Partial<VisaFields> = {};
  if (passport.family_name) out.family_name = passport.family_name;
  if (passport.given_name) out.given_name = passport.given_name;
  if (passport.passport_number) out.passport_number = passport.passport_number;
  if (passport.passport_expiry) {
    out.passport_expiration_date = toIsoDate(passport.passport_expiry);
  }
  if (passport.date_of_birth) out.date_of_birth = toIsoDate(passport.date_of_birth);
  if (passport.nationality) {
    out.current_nationality = passport.nationality;
    out.passport_issuing_country = passport.nationality;
  }
  if (passport.place_of_birth) out.city_of_birth = passport.place_of_birth;
  return out;
}

/**
 * Maps internal-passport (внутренний паспорт) OCR onto visa-anketa
 * fields. Its key contribution is `national_id_number` — the series +
 * number a загранпаспорт does not carry. Date / place of birth are
 * filled too, useful as a fallback when no загранпаспорт was sent.
 */
export function internalPassportToVisaFields(
  passport: InternalPassportIdentity,
): Partial<VisaFields> {
  const out: Partial<VisaFields> = {};
  if (passport.national_id_number) out.national_id_number = passport.national_id_number;
  if (passport.date_of_birth) out.date_of_birth = toIsoDate(passport.date_of_birth);
  if (passport.place_of_birth) out.city_of_birth = passport.place_of_birth;
  return out;
}
