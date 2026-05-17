import type { ChatClient } from "@chatman-media/rag";
import { extractJsonObject } from "./llm-json.ts";
import { nextStage } from "./stage-router.ts";
import { FUNNEL_STAGES, type FunnelStage } from "./types.ts";

/**
 * LLM-based funnel-stage classifier with regex fallback.
 *
 * The regex router (`nextStage` in stage-router.ts) is fast (sub-ms),
 * predictable, and good enough for clear-cut signals — but Russian sales
 * dialogue gets nuanced: "ну расскажи" looks like a generic follow-up to
 * regex, but in context after a value-prop it often means the prospect is
 * asking for the pitch. An LLM picks that up; regex doesn't.
 *
 * Pipeline:
 *   1. Ask the LLM to classify the current message into one of 5 stages,
 *      returning {"stage": "...", "confidence": 0.0-1.0} as JSON.
 *   2. If LLM throws OR returns malformed JSON OR returns an unknown stage
 *      OR returns confidence below the threshold — fall back to regex.
 *   3. The result includes a `source` field so the webhook (and operator
 *      tools later) can log which path was taken.
 *
 * Cost-aware notes:
 *   - Sharing the main chat client by default. On OpenRouter every turn
 *     pays ~$0.0001-0.001 extra; on Ollama+CPU classification adds 5-30s.
 *     Operators wanting cheap classification should point a small/fast
 *     model at this via `SALES_STAGE_CLASSIFIER_MODEL` env variable.
 *   - Temperature is hard-pinned to 0 for deterministic classification.
 */

export type StageSource = "llm" | "regex-fallback" | "regex";

export interface ClassifyInput {
  chat: ChatClient;
  /** The prospect's most recent message. */
  userMessage: string;
  /** Stage the conversation was on BEFORE this turn (null = fresh chat). */
  currentStage: FunnelStage | null;
  /** 1-based count of user messages so far in this conversation. */
  turnNumber: number;
  /**
   * If LLM confidence is below this, the result falls back to regex.
   * Default 0.6 — picked empirically: sub-0.6 outputs from haiku-class
   * models are nearly random, regex does at least as well.
   */
  confidenceThreshold?: number;
}

export interface ClassifyResult {
  stage: FunnelStage;
  /** LLM confidence (0..1) or 0 when regex fallback fired. */
  confidence: number;
  source: StageSource;
  /**
   * Set when fallback fired and we want the operator to see why.
   * Values: "llm-error", "parse-error", "unknown-stage", "low-confidence".
   */
  fallbackReason?: string;
}

const SYSTEM_PROMPT =
  `Ты — классификатор этапов sales-диалога в мессенджере. ` +
  `Ты получаешь последнее сообщение клиента и текущий этап разговора. ` +
  `Выдай РОВНО один JSON-объект и больше ничего:\n` +
  `{"stage": "<этап>", "confidence": <число от 0.0 до 1.0>}\n\n` +
  `Этапы:\n` +
  `- opener      — первый контакт, ещё ничего не выясняли\n` +
  `- qualify     — задаём вопросы клиенту (возраст, опыт, потребности, контекст)\n` +
  `- pitch       — рассказываем о продукте: факты, цифры, условия (после того как клиент САМ спросил детали)\n` +
  `- objection   — клиент сомневается, боится, не уверен, возражает\n` +
  `- close       — клиент готов, договариваемся о действии (созвон/встреча/оплата)\n\n` +
  `confidence: 0.9+ если уверен на 100%, 0.7 если есть варианты, ниже 0.6 если плохо понятно.\n\n` +
  `Никаких других слов, никаких префиксов вроде "Ответ:", никаких \`\`\`code-fences. ` +
  `Только JSON-объект.`;

const FUNNEL_STAGE_SET: ReadonlySet<string> = new Set(FUNNEL_STAGES);

interface ParsedClassification {
  stage: string;
  confidence: number;
}

/**
 * Robust LLM-output parser. Handles:
 *  - extra text/whitespace around the JSON
 *  - markdown code fences (```json ... ```)
 *  - leading "Ответ:" / "Result:" prefixes
 *  - trailing commentary after the closing brace
 */
export function parseClassifierOutput(
  raw: string,
): ParsedClassification | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  if (typeof obj.stage !== "string") return null;
  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
    return null;
  }
  // Clamp to [0, 1] in case the model outputs 95 instead of 0.95.
  let confidence = obj.confidence;
  if (confidence > 1) confidence = confidence / 100;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  return { stage: obj.stage, confidence };
}

/**
 * Classify the next funnel stage using LLM, with regex fallback for any
 * uncertainty. Always returns a valid `FunnelStage` — never throws.
 */
export async function classifyStage(
  input: ClassifyInput,
): Promise<ClassifyResult> {
  const threshold = input.confidenceThreshold ?? 0.6;
  const fallback = (reason: string, confidence: number): ClassifyResult => ({
    stage: nextStage({
      turnNumber: input.turnNumber,
      currentStage: input.currentStage,
      lastUserMessage: input.userMessage,
    }),
    confidence,
    source: "regex-fallback",
    fallbackReason: reason,
  });

  const userPrompt =
    `Текущий этап: ${input.currentStage ?? "(нет — это самое начало диалога)"}\n` +
    `Номер хода (счётчик клиентских сообщений): ${input.turnNumber}\n` +
    `Сообщение клиента: """${input.userMessage}"""\n\n` +
    `JSON:`;

  const classifierModel = process.env.SALES_STAGE_CLASSIFIER_MODEL;
  let raw: string;
  try {
    raw = await input.chat.complete(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      {
        temperature: 0,
        ...(classifierModel ? { model: classifierModel } : {}),
      },
    );
  } catch {
    return fallback("llm-error", 0);
  }

  const parsed = parseClassifierOutput(raw);
  if (!parsed) return fallback("parse-error", 0);

  if (!FUNNEL_STAGE_SET.has(parsed.stage)) {
    return fallback("unknown-stage", parsed.confidence);
  }

  if (parsed.confidence < threshold) {
    return fallback("low-confidence", parsed.confidence);
  }

  return {
    stage: parsed.stage as FunnelStage,
    confidence: parsed.confidence,
    source: "llm",
  };
}
