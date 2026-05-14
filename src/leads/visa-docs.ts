import { log } from "../log.ts";
import type { ChatClient, ChatMessage } from "../rag/chat.ts";

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
  city_of_birth?: string;
  marital_status?: string;
  current_nationality?: string;
  national_id_number?: string;

  // Passport
  passport_number?: string;
  passport_issuing_country?: string;
  passport_issuing_place?: string;
  passport_expiration_date?: string;

  // Contact
  current_address?: string;
  phone?: string;
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
  city_of_birth: "City of birth",
  marital_status: "Marital status",
  current_nationality: "Current nationality",
  national_id_number: "National ID number",
  passport_number: "Passport number",
  passport_issuing_country: "Passport issuing country",
  passport_issuing_place: "Passport issuing place",
  passport_expiration_date: "Passport expiration",
  current_address: "Current address",
  phone: "Phone",
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

Анкета на английском (Family name, Given name, Date of birth, Country/City of birth, Marital status, Current nationality, National ID, Passport number / issuing country / place / expiration, Address, Phone, Email, Father+Mother (name/nationality/DOB), Have you been to China?, Previous Chinese visa, Work experience, Education, Travel history past 12 months, Family).

Извлекай ТОЛЬКО то, что девушка явно написала. Никаких догадок.

Возвращаемые поля (все опциональные):
- family_name, given_name, date_of_birth (yyyy-mm-dd если возможно)
- country_of_birth, city_of_birth
- marital_status (single / married / divorced / ...)
- current_nationality
- national_id_number
- passport_number, passport_issuing_country, passport_issuing_place, passport_expiration_date
- current_address, phone, email
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
