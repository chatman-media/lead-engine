import { log } from "../log.ts";
import type { ChatClient, ChatMessage } from "../rag/chat.ts";
import type { PhotoClass } from "../rag/vision.ts";
import type { IntakeFields } from "./templates.ts";

/**
 * Auto-detection of the 7-item intake from candidate messages.
 *
 * Two signals fused:
 *   - Text-extractable fields (height / weight / city / departure
 *     readiness) come from a single LLM call with a strict JSON
 *     schema, similar to extract-user-facts.
 *   - Media counters (photos / videos) come from a SQL aggregate
 *     over messages.meta_json — the webhook stamps `media.type` on
 *     every photo / video / voice / document inbound, so we just
 *     count rows.
 *
 * Videos are counted globally for the conversation. Photos used to be
 * counted the same way, with a ">=7 photos => passport present"
 * heuristic. When vision classification is enabled (VISION_ENABLED), the
 * caller passes `photoClasses` — per-category counts — and we detect the
 * passport photo for real instead of guessing. The heuristic stays as a
 * fallback when `photoClasses` is absent.
 */
export interface IntakeExtractInput {
  /** Recent messages, oldest first, with role and text. Used by the
   *  text-field extractor — only `role: 'user'` rows are considered. */
  messages: ChatMessage[];
  /** Existing intake to refine — passed to the LLM so already-known
   *  fields don't get re-asked. */
  existingIntake?: IntakeFields;
  /** Photo / video counts pulled by `countMediaForConversation`. */
  mediaCounts: { photos: number; videos: number };
  /** Per-category photo counts from `countPhotosByClass`. Present only
   *  when vision classification is enabled — when given, passport
   *  detection uses real counts instead of the >=7 heuristic. */
  photoClasses?: Record<PhotoClass, number>;
  chat: ChatClient;
}

const SYSTEM_PROMPT = `Ты извлекаешь поля анкеты из переписки рекрутингового агентства.

Извлекай ТОЛЬКО то, что девушка явно сообщила. Никаких догадок.

Поля (все опциональные):
- age: возраст (например "22", "22 года")
- height: рост (например "165 см", "165")
- weight: вес (например "52 кг", "52")
- city: где сейчас живёт (например "Москва", "Новосибирск")
- departure_readiness: когда готова выезжать (например "с 1 апреля", "в любое время", "через 2 недели")
- name: имя и фамилия (например "Sofia Ivanova", "Иванова София")
- nationality: гражданство (например "Russian", "Россия", "казахстанское")
- marital_status: семейное положение (например "не замужем", "замужем", "single")
- children: информация о детях (например "нет", "есть, 1 ребёнок", "none")
- languages: языки и уровень (например "английский B2, базовый китайский")
- passport_expiry: дата окончания загранпаспорта (например "18.04.2029", "April 18, 2029")
- work_experience: опыт работы за последние 2 года (например "модель", "хостес, официантка")

ВЕРНИ СТРОГО JSON-ОБЪЕКТ, без markdown, без \`\`\`, без комментариев.
Если поле не упомянуто — НЕ включай его в JSON.
Если поле уже есть в "Существующие" и не изменилось — НЕ повторяй.

Пример:
Сообщения:
user: мне 22, рост 165, вес 52, я в Москве, Sofia Ivanova, гражданство Россия
Существующие: {}
Ответ:
{"age":"22","height":"165","weight":"52","city":"Москва","name":"Sofia Ivanova","nationality":"Россия"}`;

/**
 * Calls the LLM extractor for the four text-shaped intake fields. Media
 * counts are NOT touched here — caller passes those in via
 * `mediaCounts` from the SQL aggregator. Returns an updated
 * `IntakeFields` merging existing + newly-extracted + media counts.
 */
export async function extractIntake(input: IntakeExtractInput): Promise<IntakeFields> {
  const userMessages = input.messages.filter((m) => m.role === "user");
  const merged: IntakeFields = { ...(input.existingIntake ?? {}) };

  // Always overwrite media counts from the SQL aggregate — these are
  // authoritative.
  merged.photos_count = input.mediaCounts.photos;
  merged.videos_count = input.mediaCounts.videos;

  // Passport photo detection. When vision classification ran
  // (`photoClasses` present), trust the real count: >=1 photo classified
  // as a passport means the slot is filled. Otherwise fall back to the
  // legacy heuristic — total photos >= 7 implies the passport is in there
  // somewhere (operator's intake: 6-8 regular + 1 passport = 7-9 total).
  if (input.photoClasses) {
    merged.full_body_count = input.photoClasses.full_body;
    if (merged.passport_photo_received !== true && input.photoClasses.passport >= 1) {
      merged.passport_photo_received = true;
    }
  } else if (merged.passport_photo_received !== true && input.mediaCounts.photos >= 7) {
    merged.passport_photo_received = true;
  }
  // Dance video: 2 regular + 1 dance = 3+. Operator confirms by eye.
  if (merged.dance_video_received !== true && input.mediaCounts.videos >= 3) {
    merged.dance_video_received = true;
  }

  // Skip the LLM call when there are no candidate messages to read.
  if (userMessages.length === 0) return merged;

  const conversation = input.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const existingJson = JSON.stringify({
    age: merged.age,
    height: merged.height,
    weight: merged.weight,
    city: merged.city,
    departure_readiness: merged.departure_readiness,
    name: merged.name,
    nationality: merged.nationality,
    marital_status: merged.marital_status,
    children: merged.children,
    languages: merged.languages,
    passport_expiry: merged.passport_expiry,
    work_experience: merged.work_experience,
  });

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
    log.error("intake LLM extract failed", { scope: "intake", err });
    return merged;
  }

  const extracted = parseIntakeJson(raw);
  if (extracted.age) merged.age = extracted.age;
  if (extracted.height) merged.height = extracted.height;
  if (extracted.weight) merged.weight = extracted.weight;
  if (extracted.city) merged.city = extracted.city;
  if (extracted.departure_readiness) merged.departure_readiness = extracted.departure_readiness;
  if (extracted.name) merged.name = extracted.name;
  if (extracted.nationality) merged.nationality = extracted.nationality;
  if (extracted.marital_status) merged.marital_status = extracted.marital_status;
  if (extracted.children) merged.children = extracted.children;
  if (extracted.languages) merged.languages = extracted.languages;
  if (extracted.passport_expiry) merged.passport_expiry = extracted.passport_expiry;
  if (extracted.work_experience) merged.work_experience = extracted.work_experience;

  return merged;
}

/** Strips markdown / think-tags / prefixes and parses the LLM's JSON
 *  output. Validates value types before accepting. Exported for unit tests. */
export function parseIntakeJson(raw: string): Partial<IntakeFields> {
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
  const out: Partial<IntakeFields> = {};
  for (const key of [
    "age",
    "height",
    "weight",
    "city",
    "departure_readiness",
    "name",
    "nationality",
    "marital_status",
    "children",
    "languages",
    "passport_expiry",
    "work_experience",
  ] as const) {
    const val = obj[key];
    if (typeof val === "string" && val.trim() && val.trim().length <= 100) {
      out[key] = val.trim();
    }
  }
  return out;
}
