import type { AnswerTelemetry } from "@chatman-media/kb";
import { ANY_QUOTE_CURRENCY_MENTION_RE } from "../exchange-quote-currency.ts";

export const EXCHANGE_SAFE_FALLBACK =
  "Сейчас уточню у оператора и вернусь с точной суммой/реквизитами.";

export interface ExchangeReplyGuardInput {
  text: string;
  telemetry?: Pick<AnswerTelemetry, "toolCall" | "toolCalls">;
}

export type ExchangeResponseGuardAction = "pass" | "rewrite" | "escalate" | "block";

export interface ExchangeResponseGuardResult<Reason extends string = string> {
  ok: boolean;
  action: ExchangeResponseGuardAction;
  text: string;
  originalText?: string;
  reason?: Reason;
  reasons: readonly Reason[];
  requiredFixes: readonly string[];
}

export type ExchangeReplyGuardReason =
  | "rate_negotiation"
  | "unbacked_quote"
  | "unbacked_requisites"
  | "unbacked_payout_code";

export type ExchangeReplyGuardResult = ExchangeResponseGuardResult<ExchangeReplyGuardReason>;

export interface ExchangeResponseGuardFinding {
  action: ExchangeResponseGuardAction;
  reasons: readonly string[];
  requiredFixes: readonly string[];
  originalText: string;
  finalText: string;
  blocked: boolean;
}

const QUOTE_TOOLS = new Set(["compute_exchange_quote", "create_exchange_order"]);
const REQUISITES_TOOLS = new Set(["fetch_exchange_requisites"]);
const PAYOUT_TOOLS = new Set(["issue_exchange_payout"]);

const NUMBER_RE =
  /(?<![A-Za-zА-Яа-я0-9])(?:\d{1,3}(?:[ .,]\d{3})+|\d+)(?:[.,]\d+)?(?![A-Za-zА-Яа-я0-9])/u;
const NUMBER_SCAN_RE =
  /(?<![A-Za-zА-Яа-я0-9])(?:\d{1,3}(?:[ .,]\d{3})+|\d+)(?:[.,]\d+)?(?![A-Za-zА-Яа-я0-9])/gu;
// Не включаем общий глагол «получить»: он матчит бытовые справочные ответы
// («чтобы получить наличные…») и душит KB-ответы в фолбэк. Голая валюта/актив
// ниже всё равно требует ≥2 чисел (SOURCE_ASSET_RE-ветка).
const QUOTE_RE = new RegExp(
  `(?:курс|rate|отда[её]те|итог(?:овая)?\\s+сумм|${ANY_QUOTE_CURRENCY_MENTION_RE.source})`,
  "iu",
);
const SOURCE_ASSET_RE = /(?:usdt|btc|eth|usd|eur|rub|юсдт|битк|эфир|доллар|евро|руб|₽)/iu;
// «Конкретные реквизиты» = реальный артефакт (карта/крипто-адрес/URL),
// императив-оплаты на адрес/сумму, ИЛИ requisites-тема + длинный destination-номер.
// НЕ матчим бытовые «после оплаты»/«перевод» без артефакта (ложные срабатывания на
// справочных ответах про процесс выдачи).
const REQUISITES_TOPIC_RE =
  /(?:реквизит|кошел[её]к|wallet|адрес\s+(?:кошелька|для\s+оплаты)|sbp|сбп|qr\b|карт[аеуы]\b|card|binance\s*id)/iu;
const PAY_IMPERATIVE_RE =
  /(?:оплатите|переведите|отправьте|внесите)\s+(?:по|на|сумм|\d|реквизит|карт|кошел)/iu;
const DEST_NUMBER_RE = /\d[\d ]{4,}\d/u;
const PAYOUT_RE = /(?:код\s+(?:выдачи|снятия|получения)|payout\s*code)/iu;
const RATE_NEGOTIATION_RE =
  /(?:договор(?:имся|иться)|скидк|лучше\s+курс|курс\s+лучше|сдела(?:ю|ем)\s+курс|подвин(?:у|ем)\s+курс)/iu;

const CRYPTO_ADDRESS_RE = /\b(?:T[A-Za-z0-9]{25,}|0x[a-fA-F0-9]{32,}|bc1[a-z0-9]{20,})\b/u;
const CARDISH_RE = /\b(?:\d[ -]?){12,19}\b/u;
const URL_PAYMENT_RE = /\bhttps?:\/\/\S+/iu;
const CODE_RE = /\b\d{4,8}\b/u;

function successfulToolNames(telemetry: ExchangeReplyGuardInput["telemetry"]): Set<string> {
  const names = new Set<string>();
  const calls = telemetry?.toolCalls ?? (telemetry?.toolCall ? [{ ...telemetry.toolCall }] : []);
  for (const call of calls) {
    if (!call || ("error" in call && call.error)) continue;
    const result = call.result;
    if (isBlockingToolResult(result)) continue;
    names.add(call.name);
  }
  return names;
}

function isBlockingToolResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const obj = result as Record<string, unknown>;
  if (typeof obj.error === "string" && obj.error.trim()) return true;
  if (obj.needsOperator === true) return true;
  if (obj.needsVerification === true) return true;
  if (obj.ok === false) return true;
  return false;
}

function hasAny(names: Set<string>, allowed: Set<string>): boolean {
  for (const name of allowed) {
    if (names.has(name)) return true;
  }
  return false;
}

function hasConcreteQuoteClaim(text: string): boolean {
  if (!NUMBER_RE.test(text)) return false;
  if (QUOTE_RE.test(text)) return true;
  return SOURCE_ASSET_RE.test(text) && [...text.matchAll(NUMBER_SCAN_RE)].length >= 2;
}

function hasConcreteRequisitesClaim(text: string): boolean {
  if (CRYPTO_ADDRESS_RE.test(text) || CARDISH_RE.test(text) || URL_PAYMENT_RE.test(text))
    return true;
  if (PAY_IMPERATIVE_RE.test(text)) return true;
  if (!REQUISITES_TOPIC_RE.test(text)) return false;
  return DEST_NUMBER_RE.test(text);
}

function hasConcretePayoutClaim(text: string): boolean {
  return PAYOUT_RE.test(text) && CODE_RE.test(text);
}

export function exchangeGuardPass<Reason extends string>(
  text: string,
): ExchangeResponseGuardResult<Reason> {
  return {
    ok: true,
    action: "pass",
    text,
    reasons: [],
    requiredFixes: [],
  };
}

export function exchangeGuardViolation<Reason extends string>(input: {
  action: Exclude<ExchangeResponseGuardAction, "pass">;
  reason: Reason;
  text: string;
  originalText: string;
  requiredFixes: readonly string[];
}): ExchangeResponseGuardResult<Reason> {
  return {
    ok: false,
    action: input.action,
    text: input.text,
    originalText: input.originalText,
    reason: input.reason,
    reasons: [input.reason],
    requiredFixes: input.requiredFixes,
  };
}

export function exchangeGuardFindingFromResult(
  result: ExchangeResponseGuardResult,
): ExchangeResponseGuardFinding | null {
  if (result.action === "pass") return null;
  return {
    action: result.action,
    reasons: result.reasons,
    requiredFixes: result.requiredFixes,
    originalText: result.originalText ?? result.text,
    finalText: result.text,
    blocked: result.action === "block",
  };
}

export function guardExchangeReply(input: ExchangeReplyGuardInput): ExchangeReplyGuardResult {
  const text = input.text.trim();
  if (!text) return exchangeGuardPass(text);

  if (RATE_NEGOTIATION_RE.test(text)) {
    return exchangeGuardViolation({
      action: "rewrite",
      reason: "rate_negotiation",
      text: EXCHANGE_SAFE_FALLBACK,
      originalText: text,
      requiredFixes: [
        "Use configured rate table or compute_exchange_quote; do not negotiate rate manually.",
      ],
    });
  }

  const tools = successfulToolNames(input.telemetry);

  if (hasConcreteQuoteClaim(text) && !hasAny(tools, QUOTE_TOOLS)) {
    return exchangeGuardViolation({
      action: "rewrite",
      reason: "unbacked_quote",
      text: EXCHANGE_SAFE_FALLBACK,
      originalText: text,
      requiredFixes: [
        "Call compute_exchange_quote or create_exchange_order before sending a concrete rate or payout amount.",
      ],
    });
  }

  if (hasConcreteRequisitesClaim(text) && !hasAny(tools, REQUISITES_TOOLS)) {
    return exchangeGuardViolation({
      action: "rewrite",
      reason: "unbacked_requisites",
      text: EXCHANGE_SAFE_FALLBACK,
      originalText: text,
      requiredFixes: [
        "Call fetch_exchange_requisites after the order is ready for payment; otherwise ask the next missing field.",
      ],
    });
  }

  if (hasConcretePayoutClaim(text) && !hasAny(tools, PAYOUT_TOOLS)) {
    return exchangeGuardViolation({
      action: "escalate",
      reason: "unbacked_payout_code",
      text: EXCHANGE_SAFE_FALLBACK,
      originalText: text,
      requiredFixes: [
        "Issue payout through issue_exchange_payout or operator approval before sending a payout code.",
      ],
    });
  }

  return exchangeGuardPass(text);
}

/** Минимальный chat-интерфейс для перезапроса (совместим с llm-router ChatClient). */
export interface UnbackedQuoteRewriteChat {
  complete(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    opts?: { temperature?: number },
  ): Promise<string>;
}

const UNBACKED_QUOTE_REWRITE_SYSTEM = [
  "Ты — вежливый менеджер обменного пункта.",
  "Твой черновик ответа содержал курс или сумму, которых нет от инструмента расчёта — так нельзя.",
  "Перепиши ответ БЕЗ каких-либо конкретных чисел курса или суммы.",
  "Если клиент ещё не назвал сумму и направление обмена — коротко и дружелюбно попроси назвать их.",
  "Если клиент уже всё назвал — скажи, что считаешь курс и сейчас вернёшься с точной суммой.",
  "Отвечай на языке клиента, 1–2 предложения, без чисел.",
].join(" ");

/**
 * Перезапрос при unbacked_quote: вместо жёсткой заглушки просим модель переписать
 * ответ без выдуманных чисел (нет суммы → просто спросить направление и сумму).
 * Один дешёвый chat.complete. null — перезапрос не удался (вызывающий оставит
 * безопасный фоллбэк).
 */
export async function rewriteUnbackedQuoteReply(input: {
  chat: UnbackedQuoteRewriteChat;
  userMessage: string;
  draftReply: string;
}): Promise<string | null> {
  try {
    const out = await input.chat.complete(
      [
        { role: "system", content: UNBACKED_QUOTE_REWRITE_SYSTEM },
        {
          role: "user",
          content: `Сообщение клиента: ${input.userMessage}\n\nТвой черновик ответа (содержит недопустимые числа): ${input.draftReply}\n\nПерепиши ответ.`,
        },
      ],
      { temperature: 0.3 },
    );
    const text = out?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
