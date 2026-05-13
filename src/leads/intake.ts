import type { Database } from "bun:sqlite";

import type { ChatClient, ChatMessage } from "../rag/chat.ts";
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
 * Photos and videos are counted globally for the conversation, not
 * partitioned by "is this the passport photo / dance video?". That
 * heuristic is intentional: distinguishing requires per-photo LLM
 * classification which is expensive and operator-eyes-on-chat is
 * already a sufficient verification step before approval. We just
 * need a reasonable threshold (>=7 photos, >=3 videos) to suggest
 * intake is plausibly complete; the operator confirms by approving.
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
  chat: ChatClient;
}

const SYSTEM_PROMPT = `Ты извлекаешь 5 полей анкеты из переписки рекрутингового агентства.

Извлекай ТОЛЬКО то, что девушка явно сообщила. Никаких догадок.

Поля (все опциональные):
- age: возраст (например "22", "22 года")
- height: рост (например "165 см", "165")
- weight: вес (например "52 кг", "52")
- city: где сейчас живёт (например "Москва", "Новосибирск")
- departure_readiness: когда готова выезжать (например "с 1 апреля", "в любое время", "через 2 недели")

ВЕРНИ СТРОГО JSON-ОБЪЕКТ, без markdown, без \`\`\`, без комментариев.
Если поле не упомянуто — НЕ включай его в JSON.
Если поле уже есть в "Существующие" и не изменилось — НЕ повторяй.

Пример:
Сообщения:
user: мне 22, рост 165, вес 52
user: я в Москве
Существующие: {}
Ответ:
{"age":"22","height":"165","weight":"52","city":"Москва"}`;

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

  // Heuristic for passport photo / dance video: when total photos >= 7
  // we assume the passport-photo slot is filled (operator's intake
  // says 6-8 regular + 1 passport = 7-9 total). Same for videos: 2
  // regular + 1 dance = 3+. Operator confirms by eye before approving.
  if (merged.passport_photo_received !== true && input.mediaCounts.photos >= 7) {
    merged.passport_photo_received = true;
  }
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
    console.error("[intake] LLM extract failed:", err);
    return merged;
  }

  const extracted = parseIntakeJson(raw);
  if (extracted.age) merged.age = extracted.age;
  if (extracted.height) merged.height = extracted.height;
  if (extracted.weight) merged.weight = extracted.weight;
  if (extracted.city) merged.city = extracted.city;
  if (extracted.departure_readiness) merged.departure_readiness = extracted.departure_readiness;

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
  for (const key of ["age", "height", "weight", "city", "departure_readiness"] as const) {
    const val = obj[key];
    if (typeof val === "string" && val.trim() && val.trim().length <= 100) {
      out[key] = val.trim();
    }
  }
  return out;
}

/**
 * SQL aggregate over messages.meta_json — counts photos and videos
 * sent by the candidate (role='user') in this conversation. SQLite's
 * json_extract goes through the meta_json blob; we only filter on the
 * media.type so the path is short and indexable.
 */
export function countMediaForConversation(
  db: Database,
  conversationId: number,
): { photos: number; videos: number } {
  const rows = db
    .query<{ kind: string; n: number }, [number]>(
      `SELECT json_extract(meta_json, '$.media.type') AS kind,
              COUNT(*) AS n
       FROM messages
       WHERE conversation_id = ?
         AND role = 'user'
         AND meta_json IS NOT NULL
         AND json_extract(meta_json, '$.media.type') IS NOT NULL
       GROUP BY kind`,
    )
    .all(conversationId);
  let photos = 0;
  let videos = 0;
  for (const r of rows) {
    if (r.kind === "photo") photos = r.n;
    else if (r.kind === "video") videos = r.n;
  }
  return { photos, videos };
}
