import type { ChatClient, ChatMessage } from "./chat.ts";

/**
 * Extracts persistent facts ABOUT THE CANDIDATE (not the bot persona) from
 * a slice of conversation. Used by the cross-session memory layer in
 * webhook → after each turn the new messages are passed here and the result
 * merged into `users.profile_json.memory.facts`.
 *
 * Facts schema is flexible — the prompt encourages the most common keys for
 * the recruitment use-case but allows free-form keys when the candidate
 * volunteers something unusual ("instagram", "previous_agency", …). Only
 * volunteered facts are returned — no inference or guessing.
 */
export interface ExtractFactsInput {
  /** Recent messages, oldest first. Should include both user and bot turns. */
  messages: ChatMessage[];
  chat: ChatClient;
  /** Existing facts so the LLM doesn't re-emit already-known data. */
  existingFacts?: Record<string, string>;
}

const SYSTEM_PROMPT = `Ты извлекаешь факты О КАНДИДАТЕ из переписки рекрутингового агентства.
Анализируй ТОЛЬКО реплики кандидата (role=user). Реплики бота (role=assistant) — для контекста.

Извлекай только факты, которые КАНДИДАТ САМ ЯВНО СООБЩИЛ. Никаких догадок и вывода.

Типичные ключи (используй их когда подходит):
- name: имя кандидата
- city: город/страна где живёт сейчас
- age: возраст (число)
- experience: опыт работы (что уже делал)
- language: какие языки знает
- country_target: куда хочет поехать работать
- intent: что ищет ("работа моделью", "поездка в Дубай", "разовый контракт")
- contact: telegram/instagram/email если давал

Можешь добавлять свои ключи (snake_case) если кандидат сообщил что-то ещё.

ВЕРНИ СТРОГО JSON-ОБЪЕКТ, без markdown, без \`\`\`, без комментариев.
Если фактов нет — верни {}.
Если факт уже есть в "Существующие факты" и не изменился — не повторяй его.
Только новые или ОБНОВЛЁННЫЕ факты.

Пример:
Сообщения:
user: привет, я Аня из новосибирска, мне 23
user: ищу работу в дубае, хочу заработать
Существующие факты: {}
Ответ:
{"name":"Аня","city":"Новосибирск","age":"23","country_target":"Дубай","intent":"работа, заработок"}`;

const MAX_RETURNED_KEYS = 20;
const MAX_VALUE_LEN = 200;

export async function extractUserFacts(input: ExtractFactsInput): Promise<Record<string, string>> {
  // No new messages → nothing to extract. Skip LLM call entirely.
  const userMessages = input.messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) return {};

  const conversation = input.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const existingJson = JSON.stringify(input.existingFacts ?? {});

  const userPrompt = `Сообщения:\n${conversation}\n\nСуществующие факты: ${existingJson}\n\nОтвет:`;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let raw: string;
  try {
    raw = await input.chat.complete(messages, { temperature: 0.1 });
  } catch (err) {
    console.error("[extract-user-facts] LLM call failed:", err);
    return {};
  }

  return parseFactsFromLlmOutput(raw);
}

/**
 * Parses the LLM output — strips think-tags and markdown fences, finds the
 * JSON object, validates that values are short strings, caps total keys.
 * Exported for unit tests.
 */
export function parseFactsFromLlmOutput(raw: string): Record<string, string> {
  let s = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/```(?:json)?/gi, "").trim();

  // Find the first {...} block. The model sometimes prefixes "Ответ:" or similar.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return {};

  const candidate = s.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const result: Record<string, string> = {};
  let count = 0;
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (count >= MAX_RETURNED_KEYS) break;
    if (typeof key !== "string" || key.length === 0 || key.length > 40) continue;
    if (val === null || val === undefined) continue;
    const str = typeof val === "string" ? val : String(val);
    const trimmed = str.trim();
    if (!trimmed || trimmed.length > MAX_VALUE_LEN) continue;
    result[key] = trimmed;
    count++;
  }
  return result;
}
