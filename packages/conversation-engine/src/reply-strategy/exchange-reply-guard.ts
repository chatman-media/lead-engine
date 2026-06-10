import type { AnswerTelemetry } from "@chatman-media/kb";

export const EXCHANGE_SAFE_FALLBACK =
  "Сейчас уточню у оператора и вернусь с точной суммой/реквизитами.";

export interface ExchangeReplyGuardInput {
  text: string;
  telemetry?: Pick<AnswerTelemetry, "toolCall" | "toolCalls">;
}

export interface ExchangeReplyGuardResult {
  ok: boolean;
  text: string;
  reason?: string;
}

const QUOTE_TOOLS = new Set(["compute_exchange_quote", "create_exchange_order"]);
const REQUISITES_TOOLS = new Set(["fetch_exchange_requisites"]);
const PAYOUT_TOOLS = new Set(["issue_exchange_payout"]);

const NUMBER_RE =
  /(?<![A-Za-zА-Яа-я0-9])(?:\d{1,3}(?:[ .,]\d{3})+|\d+)(?:[.,]\d+)?(?![A-Za-zА-Яа-я0-9])/u;
const NUMBER_SCAN_RE =
  /(?<![A-Za-zА-Яа-я0-9])(?:\d{1,3}(?:[ .,]\d{3})+|\d+)(?:[.,]\d+)?(?![A-Za-zА-Яа-я0-9])/gu;
const QUOTE_RE =
  /(?:курс|rate|отда[её]те|получ(?:а(?:ете|ешь)|ите|у|ится|ить)|итог(?:овая)?\s+сумм|thb|бат|bhat)/iu;
const SOURCE_ASSET_RE = /(?:usdt|btc|eth|usd|eur|rub|юсдт|битк|эфир|доллар|евро|руб|₽)/iu;
const REQUISITES_RE =
  /(?:реквизит|кошел[её]к|wallet|адрес\s+(?:кошелька|для\s+оплаты)|оплат\w*|перев(?:од|ести)|sbp|сбп|qr|карта|card|binance\s*id)/iu;
const PAYOUT_RE =
  /(?:код\s+(?:выдачи|снятия|получения)|payout\s*code)/iu;
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
  if (CRYPTO_ADDRESS_RE.test(text) || CARDISH_RE.test(text)) return true;
  if (!REQUISITES_RE.test(text)) return false;
  return URL_PAYMENT_RE.test(text) || NUMBER_RE.test(text) || /(?:перев(?:едите|ести)|оплат(?:ите|ить)|адрес|ссылка)/iu.test(text);
}

function hasConcretePayoutClaim(text: string): boolean {
  return PAYOUT_RE.test(text) && CODE_RE.test(text);
}

export function guardExchangeReply(input: ExchangeReplyGuardInput): ExchangeReplyGuardResult {
  const text = input.text.trim();
  if (!text) return { ok: true, text };

  if (RATE_NEGOTIATION_RE.test(text)) {
    return { ok: false, text: EXCHANGE_SAFE_FALLBACK, reason: "rate_negotiation" };
  }

  const tools = successfulToolNames(input.telemetry);

  if (hasConcreteQuoteClaim(text) && !hasAny(tools, QUOTE_TOOLS)) {
    return { ok: false, text: EXCHANGE_SAFE_FALLBACK, reason: "unbacked_quote" };
  }

  if (hasConcreteRequisitesClaim(text) && !hasAny(tools, REQUISITES_TOOLS)) {
    return { ok: false, text: EXCHANGE_SAFE_FALLBACK, reason: "unbacked_requisites" };
  }

  if (hasConcretePayoutClaim(text) && !hasAny(tools, PAYOUT_TOOLS)) {
    return { ok: false, text: EXCHANGE_SAFE_FALLBACK, reason: "unbacked_payout_code" };
  }

  return { ok: true, text };
}
