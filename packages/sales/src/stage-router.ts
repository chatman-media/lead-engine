import type { FunnelStage } from "./types.ts";

export interface StageInput {
  /** 1-based count of user messages received so far in this conversation. */
  turnNumber: number;
  /** What stage we were on for the previous turn (null = first turn ever). */
  currentStage: FunnelStage | null;
  /** The prospect's most recent message. */
  lastUserMessage: string;
}

// JS regex `\b` only recognizes ASCII word boundaries — it silently fails on
// Cyrillic. Use a Unicode-aware delimiter group instead: start-of-string,
// whitespace, or any non-letter/non-digit character. This matches across both
// languages.
const D = "(?:^|[^\\p{L}\\p{N}])"; // delim before
const E = "(?:[^\\p{L}\\p{N}]|$)"; // delim after

const RE = {
  objection: new RegExp(
    `${D}(но|сомнев|боюсь|развод|обман|опас|подозр|слишком|не уверен|не сейчас|не могу|почему|зачем|страшно|стрём)`,
    "iu",
  ),
  // "pricing" is misleadingly named — it really means "info-seeking" /
  // "show me what you've got". Includes vacancy-listing intent ("какие
  // вакансии", "давай по всем", "что у вас сейчас") so the bot enters
  // the `pitch` stage and grounds in АКТУАЛЬНЫЕ ВАКАНСИИ instead of
  // looping back to the opener self-introduction.
  pricing: new RegExp(
    `${D}(сколько|цена|стоит|зарплат|оплат|комисси|услови|деньги|долл|евро|виза|контракт|документ|гонорар|плат|ваканс|оффер|какие\\s+(есть|у\\s+вас|у\\s+вас\\s+есть)|что\\s+у\\s+вас|по\\s+всем|все\\s+ваканс|какие\\s+ваканс|варианты|направлен|страны|где\\s+работ|куда\\s+(можно|едут|ехать)|kтv|ktv|караоке|хостес)`,
    "iu",
  ),
  agreement: new RegExp(
    `${D}(ок|ладно|давай|согласн|готов|хочу|поехали|интересно|подходит|когда созв|удобн)${E}`,
    "iu",
  ),
  qualifier:
    /(\d{2}\s*лет|года?\s|город[еа]|опыт|был[ао]|есть ли|занималась|занимался)/iu,
  greeting: /^\s*(привет|hi|hey|здрав|добр)/iu,
};

/**
 * Naive rule-based stage router. Suitable for an MVP — predictable and zero-cost.
 *
 * Upgrade path: replace with an LLM classifier (haiku-class model) that returns
 * `{stage, confidence}`; keep these rules as a confidence-floor fallback.
 */
export function nextStage(input: StageInput): FunnelStage {
  const { turnNumber, currentStage, lastUserMessage } = input;
  const text = lastUserMessage.toLowerCase();

  if (RE.objection.test(text)) return "objection";
  if (RE.pricing.test(text)) return "pitch";

  if (
    RE.agreement.test(text) &&
    (currentStage === "pitch" ||
      currentStage === "qualify" ||
      currentStage === "objection")
  ) {
    return "close";
  }

  if (turnNumber <= 1) return currentStage ?? "opener";
  if (currentStage === "opener") return "qualify";
  if (currentStage === "qualify" && RE.qualifier.test(text)) return "qualify";
  if (currentStage === "close") return "close";

  return currentStage ?? "qualify";
}
