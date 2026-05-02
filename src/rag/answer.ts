import type { KbRepo, KbSearchHit } from "../db/repos/kb.ts";
import { composeSystemPrompt } from "../sales/prompt.ts";
import type { FunnelStage, Style } from "../sales/types.ts";
import type { ChatClient, ChatMessage } from "./chat.ts";
import type { EmbeddingClient } from "./embed.ts";

/** Sentinel returned when retrieval is empty (or LLM cannot answer from
 * CONTEXT alone). The webhook layer turns this into a polite stall
 * reply ("секунду, уточню…") and queues the chat for the admin. */
export const NO_CONTEXT_MARKER = "__NO_CONTEXT__";

export interface Persona {
  /** Display name used in chat ("Алина", "Менеджер ALINA", etc.). */
  name: string;
  /** "human" → poses as a real person; "assistant" → openly an AI helper. */
  role: "human" | "assistant";
  /** Optional company / agency name. */
  company?: string;
}

const DEFAULT_PERSONA: Persona = {
  name: "Менеджер",
  role: "assistant",
  company: "",
};

/** True when the message is only smalltalk about identity (name / who are you). */
export function isPersonaSmalltalkQuestion(question: string): boolean {
  const q = question.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return false;
  const hasJobOrOfferIntent =
    /(работ|ваканс|зарплат|виза|оффер|переезд|агентств|услов|\bофис\b|график|смен|жилье|жильё|рейс|кита|китай|коре|англ\b)/i.test(
      question,
    );
  if (hasJobOrOfferIntent) return false;

  const nameCue =
    q.includes("как тебя зовут") ||
    q.includes("как вас зовут") ||
    q.includes("тебя как зовут") ||
    /как\s+(твоё|твое)\s+имя/i.test(question);
  const whoCue =
    /^кто\s+ты\??$/i.test(question.trim()) ||
    /^ты\s+кто\??$/i.test(question.trim());

  const enName = /\bwhat\s+('?s\s+)?your\s+name\b/i.test(question);
  const enWho = /\bwho\s+are\s+you\b/i.test(question);

  return !!(nameCue || whoCue || enName || enWho);
}

/** Short reply derived from persona — no KB required. */
export function personaSmalltalkReply(persona: Persona): string {
  const name = persona.name?.trim() || "Менеджер";
  const company = persona.company?.trim();
  if (persona.role === "human") {
    if (company) {
      return `Меня зовут ${name}, я менеджер в ${company}. Пиши, если нужна работа или условия — разберёмся.`;
    }
    return `Меня зовут ${name}.`;
  }
  if (company) return `Я ${name}, помощник агентства ${company}.`;
  return `Я ${name}.`;
}

/**
 * Builds the system prompt. Two flavors keyed off `persona.role`:
 *
 * - "human"     — model speaks as a real human manager. Hard rules against
 *                 outing itself as AI/bot/LLM. Tone: short, warm, conversational.
 * - "assistant" — explicit AI assistant of the company.
 *
 * In both modes the model is forbidden from inventing facts and MUST emit
 * the bare `NO_CONTEXT_MARKER` if the answer is not in CONTEXT.
 */
export function buildSystemPrompt(persona: Persona, context: string): string {
  const company = persona.company?.trim();
  const personaLine =
    persona.role === "human"
      ? `Тебя зовут ${persona.name}${company ? `, ты менеджер агентства ${company}` : ""}. ` +
        `Ты живой человек, работающий в переписке с кандидатом в Telegram. ` +
        `НИКОГДА не упоминай и не намекай, что ты ИИ, бот, ассистент, ` +
        `языковая модель, чат-бот, нейросеть, программа или система. ` +
        `НИКОГДА не пиши о себе в третьем лице, не говори про «оператора», ` +
        `«коллегу», «менеджера передаст», «свяжитесь с менеджером» — ты ` +
        `и есть тот самый менеджер, который ведёт диалог. ` +
        `Если кандидат прямо спрашивает «ты бот?» — отвечай уклончиво и ` +
        `по-живому ("конечно нет, я ${persona.name}, чем помочь?"), ` +
        `без оправданий. ` +
        `Пиши коротко, тепло и по-человечески, как в обычной переписке.`
      : `Тебя зовут ${persona.name}, ты ИИ-ассистент${company ? ` агентства ${company}` : ""}. ` +
        `Отвечай вежливо и по делу.`;

  const rules =
    `СТРОГИЕ ПРАВИЛА:\n` +
    `1. Используй для фактов о вакансиях, условиях, странах и цифрах ТОЛЬКО ` +
    `секцию CONTEXT ниже. Если в CONTEXT есть информация по теме вопроса — ` +
    `обязательно ответь по сути, передай факты своими словами, дружелюбно и ` +
    `по-человечески. Не используй общие знания о мире, не сочиняй цифры, цены, ` +
    `сроки, города, названия стран, которых нет в CONTEXT. ` +
    `(Исключение: чисто персональный вопрос об имени/роли — см. п. 2a.)\n` +
    `2. Маркер "${NO_CONTEXT_MARKER}" верни РОВНО и БЕЗ каких-либо других ` +
    `слов в любом из этих случаев:\n` +
    `   - в CONTEXT нет фактов по теме вопроса;\n` +
    `   - в CONTEXT упоминается одна страна / город / локация / валюта, а ` +
    `вопрос про другую (например, в CONTEXT про Китай и юани, а спросили про ` +
    `Корею) — НЕЛЬЗЯ переносить факты с одной локации на другую;\n` +
    `   - в CONTEXT нужных конкретных цифр/условий нет, а вопрос требует ` +
    `именно их.\n` +
    `Если CONTEXT прямо отвечает на вопрос — отвечай по нему, не сваливайся ` +
    `на маркер.\n` +
    `2a. Если вопрос только о твоём имени или кто ты («как тебя зовут», «кто ты») — ответь ` +
    `по описанию в начале сообщения выше (имя, агентство). Никаких фактов о вакансиях ` +
    `от себя не добавляй. Маркер "${NO_CONTEXT_MARKER}" в этом случае НЕ используй.\n` +
    `3. Пиши ТОЛЬКО на русском языке, даже если вопрос задан на другом. ` +
    `Без префиксов вроде "Ответ:", "Согласно контексту", "Based on…", ` +
    `"<think>" и т.п. Никаких служебных тегов и рассуждений вслух.\n` +
    `4. Будь кратким — 1–5 предложений или короткий список из 2–4 пунктов, ` +
    `если перечисляешь. Без markdown-заголовков, без эмодзи-перебора. ` +
    `Стиль — живая переписка в мессенджере.\n` +
    `5. Не переспрашивай «что именно интересует / о чём расскажешь / ` +
    `уточни вопрос» — отвечай сразу по сути исходного вопроса по фактам ` +
    `из CONTEXT. Уточняющий встречный вопрос допустим только если без него ` +
    `ответ физически невозможен.`;

  return `${personaLine}\n\n${rules}\n\nCONTEXT:\n${context}`;
}

export interface AnswerInput {
  question: string;
  kb: KbRepo;
  embedder: EmbeddingClient;
  chat: ChatClient;
  /** Recent dialog messages (oldest first), excluding the current question. */
  history?: ChatMessage[];
  topK?: number;
  /** Used to drop noisy hits; sqlite-vec returns L2 distance (lower=closer). */
  maxDistance?: number;
  /** Persona settings (see buildSystemPrompt). Optional — defaults to a
   *  generic AI-assistant persona for backward compatibility with tests.
   *  Mutually exclusive with `style`: when both are present, `style` wins. */
  persona?: Persona;
  /**
   * Sales style — when provided, the system prompt is composed via the sales
   * engine (`composeSystemPrompt`) instead of the legacy `buildSystemPrompt`.
   * `persona` is then ignored. See `src/sales/types.ts` for the schema and
   * `docs/SALES_STYLES.md` for the integration plan.
   */
  style?: Style;
  /**
   * Current funnel stage. Required when `style` is set; ignored otherwise.
   * Drives stage-specific guidance (opener vs pitch vs objection etc.) inside
   * the composed system prompt.
   */
  stage?: FunnelStage;
  /**
   * Whether to include the style's few-shot examples in the system prompt.
   * Default `true` (first turn). Pass `false` on follow-ups to save 200-500
   * tokens once the style anchor is already in chat history.
   */
  includeFewShot?: boolean;
}

export interface AnswerResult {
  text: string;
  usedChunkIds: number[];
  hits: KbSearchHit[];
}

export async function answerWithRag(input: AnswerInput): Promise<AnswerResult> {
  const activePersona: Persona =
    input.style != null
      ? {
          name: input.style.persona.name,
          role: input.style.persona.role,
          ...(input.style.persona.company != null &&
          input.style.persona.company.trim() !== ""
            ? { company: input.style.persona.company.trim() }
            : {}),
        }
      : (input.persona ?? DEFAULT_PERSONA);

  if (isPersonaSmalltalkQuestion(input.question)) {
    return {
      text: personaSmalltalkReply(activePersona),
      usedChunkIds: [],
      hits: [],
    };
  }

  const topK = input.topK ?? 5;
  const [questionVec] = await input.embedder.embed([input.question]);
  if (!questionVec) throw new Error("Embedder returned no vector for question");

  const allHits = input.kb.search(questionVec, topK);
  const hits =
    input.maxDistance === undefined
      ? allHits
      : allHits.filter((h) => h.distance <= input.maxDistance!);

  if (hits.length === 0) {
    return { text: NO_CONTEXT_MARKER, usedChunkIds: [], hits: [] };
  }

  const context = hits
    .map(
      (h, i) =>
        `[#${i + 1}] (source: ${h.title})\n${h.text}`,
    )
    .join("\n\n");

  // Branch: sales-style engine vs legacy persona prompt.
  // `style` wins over `persona` when both are passed.
  let systemPrompt: string;
  let temperature = 0.2;
  if (input.style) {
    const stage: FunnelStage = input.stage ?? "qualify";
    systemPrompt = composeSystemPrompt(input.style, stage, context, {
      includeFewShot: input.includeFewShot ?? true,
    });
    temperature = input.style.model.temperature;
  } else {
    systemPrompt = buildSystemPrompt(input.persona ?? DEFAULT_PERSONA, context);
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(input.history ?? []),
    { role: "user", content: input.question },
  ];

  const raw = await input.chat.complete(messages, { temperature });
  const text = sanitizeLlmOutput(raw);
  return {
    text,
    usedChunkIds: hits.map((h) => h.chunk_id),
    hits,
  };
}

/**
 * Strip artifacts some chat models emit despite system instructions:
 * - `<think>…</think>` reasoning blocks (qwen3, deepseek-r1 style).
 * - leading "Answer:" / "Ответ:" / "Согласно контексту" prefixes.
 * - surrounding whitespace.
 *
 * Exported for unit tests.
 */
export function sanitizeLlmOutput(raw: string): string {
  let s = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/^\s*<think\b[^>]*>[\s\S]*$/i, "");
  s = s.replace(
    /^\s*(?:answer|ответ|reply|response|согласно\s+контексту)\s*[:\-—]\s*/i,
    "",
  );
  return s.trim();
}
