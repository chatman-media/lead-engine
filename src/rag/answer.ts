import type { KbRepo, KbSearchHit } from "../db/repos/kb.ts";
import type { ChatClient, ChatMessage } from "./chat.ts";
import type { EmbeddingClient } from "./embed.ts";

/** Sentinel returned when retrieval is empty; webhook layer can use this
 * to escalate to a human operator instead of inventing an answer. */
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
        `Ты живой человек. НИКОГДА не говори, что ты ИИ, бот, ассистент, ` +
        `языковая модель или чат-бот. Не используй формулировки типа ` +
        `"как ИИ я не могу...", "я искусственный интеллект", "я бот". ` +
        `Если кандидат прямо спрашивает «ты бот?» — отвечай уклончиво, ` +
        `как реальный менеджер ("я менеджер агентства, чем помочь?"). ` +
        `Пиши коротко, тепло и по-человечески, как в живой переписке.`
      : `Тебя зовут ${persona.name}, ты ИИ-ассистент${company ? ` агентства ${company}` : ""}. ` +
        `Отвечай вежливо и по делу.`;

  const rules =
    `СТРОГИЕ ПРАВИЛА:\n` +
    `1. Отвечай ТОЛЬКО на основании секции CONTEXT ниже. Не используй общие ` +
    `знания о мире, не рассуждай "вообще про работу/страны/визы".\n` +
    `2. Если в CONTEXT нет прямого ответа на вопрос — верни РОВНО строку ` +
    `"${NO_CONTEXT_MARKER}" без каких-либо пояснений и без дополнительных слов. ` +
    `Не говори "в контексте нет данных", не давай общие соображения, ` +
    `просто верни маркер и всё.\n` +
    `3. Не выдумывай цифры, цены, условия, сроки. Если их нет в CONTEXT — ` +
    `возвращай маркер.\n` +
    `4. Пиши на языке вопроса (обычно русский), без префиксов вроде ` +
    `"Ответ:" или "Согласно контексту".\n` +
    `5. Будь кратким — 1–4 предложения. Без markdown-заголовков и нумерованных ` +
    `списков, если только пользователь явно не просит структуру.`;

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
   *  generic AI-assistant persona for backward compatibility with tests. */
  persona?: Persona;
}

export interface AnswerResult {
  text: string;
  usedChunkIds: number[];
  hits: KbSearchHit[];
}

export async function answerWithRag(input: AnswerInput): Promise<AnswerResult> {
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
  const systemPrompt = buildSystemPrompt(input.persona ?? DEFAULT_PERSONA, context);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(input.history ?? []),
    { role: "user", content: input.question },
  ];

  const text = await input.chat.complete(messages, { temperature: 0.2 });
  return {
    text,
    usedChunkIds: hits.map((h) => h.chunk_id),
    hits,
  };
}
