import type { AnswerTelemetry } from "@chatman-media/kb";
import type { MessageRow } from "../dal/messages.ts";
import {
	EXCHANGE_SAFE_FALLBACK,
	type ExchangeReplyGuardInput,
	type ExchangeReplyGuardResult,
	guardExchangeReply,
} from "./exchange-reply-guard.ts";

export const EXCHANGE_KYC_FALLBACK =
	"Передаю верификацию оператору. Я не подтверждаю KYC автоматически в чате.";

export const EXCHANGE_PAYMENT_FALLBACK =
	"Проверку оплаты должен выполнить оператор или платёжный сервис. Передаю заявку на проверку.";

export const EXCHANGE_PAYOUT_FALLBACK =
	"Выдачу подтверждает оператор после проверки оплаты. Передаю заявку оператору.";

export interface ExchangePolicyGuardInput extends ExchangeReplyGuardInput {
	history?: Array<Pick<MessageRow, "role" | "text">>;
	stageSlug?: string | null;
	state?: ExchangePolicyState | null;
}

export interface ExchangePolicyGuardResult extends ExchangeReplyGuardResult {
	reason?:
		| ExchangeReplyGuardResult["reason"]
		| "kyc_auto_verified"
		| "payment_auto_verified"
		| "payout_auto_completed"
		| "requisites_while_kyc_pending";
}

export interface ExchangePolicyState {
	stageSlug?: string | null;
	verification?: ExchangeVerificationPolicyState | null;
	order?: ExchangeOrderPolicyState | null;
}

export interface ExchangeVerificationPolicyState {
	verified: boolean;
	status: string;
	needsVerification: boolean;
	verificationId?: string | null;
}

export interface ExchangeOrderPolicyState {
	id: number;
	status: string;
	assetFrom?: string | null;
	network?: string | null;
	amountMode?: string | null;
	requestedAmount?: number | null;
	amountFrom?: number | null;
	rate?: number | null;
	amountToThb?: number | null;
	paymentMethod?: string | null;
	paymentRail?: string | null;
	payoutMethod?: string | null;
	payoutLocation?: string | null;
	payoutDestinationJson?: string | null;
	requisitesIssued: boolean;
	paymentProofReceived: boolean;
	paymentVerified: boolean;
	payoutReady: boolean;
	payoutCompleted: boolean;
	payoutCodeIssued: boolean;
	verificationId?: string | null;
}

const KYC_PENDING_STAGES = new Set([
	"verification_check",
	"kyc_collection",
	"risk_review",
]);

const KYC_REQUEST_RE =
	/(?:верификац|kyc|документ|паспорт|видео|кружок)[^.!\n]{0,120}(?:нужн|обязательн|пришл|отправ|требуется|пройти)|(?:нужн|обязательн|пришл|отправ|пройти)[^.!\n]{0,120}(?:верификац|kyc|документ|паспорт|видео|кружок)/iu;
const KYC_VERIFIED_RE =
	/(?:верификац|kyc|документ|паспорт|видео|кружок)[^.!\n]{0,120}(?:подтвержд[её]н|подтверждена|подтверждено|пройд[её]н|пройдена|проверен|проверена|успешн)|(?:я\s+)?проверил(?:а|и)?[^.!\n]{0,120}(?:верификац|kyc|документ|паспорт|видео|кружок)/iu;

const PAYMENT_VERIFIED_RE =
	/(?:оплат|перевод|чек|receipt|proof)[^.!\n]{0,120}(?:подтвержден|подтверждена|получен|получена|зачислен|зачислена|проверен|проверена|успешн)|(?:я\s+)?проверил(?:а|и)?[^.!\n]{0,80}(?:оплат|перевод|чек)/iu;

const PAYOUT_COMPLETED_RE =
	/(?:выдач|выплат|payout|код\s+(?:выдачи|снятия|получения)|деньги|баты|thb)[^.!\n]{0,120}(?:готов|готова|выдан|выдана|отправлен|отправлена|завершен|завершена|исполнен|исполнена|можно\s+забирать|можно\s+снимать)|(?:заявка|обмен)[^.!\n]{0,80}(?:завершен|завершена|выполнен|выполнена)/iu;

const CONCRETE_REQUISITES_OR_PAYMENT_RE =
	/(?:оплатите|переведите|отправьте|внесите|кошел[её]к|адрес\s+(?:кошелька|для\s+оплаты)|карта|card|sbp|сбп|qr|binance\s*id|реквизит(?:ы|ам)?)[^.!\n]{0,160}(?:\d{4,}|https?:\/\/|T[A-Za-z0-9]{25,}|0x[a-fA-F0-9]{32,}|bc1[a-z0-9]{20,}|оплатите|переведите|отправьте)/iu;

function isBlockingToolResult(toolName: string, result: unknown): boolean {
	if (typeof result !== "object" || result === null) return false;
	const obj = result as Record<string, unknown>;
	if (typeof obj.error === "string" && obj.error.trim()) return true;
	if (obj.needsOperator === true) return true;
	if (obj.needsVerification === true) return true;
	if (obj.ok === false) return true;
	if (toolName === "check_exchange_verification" && obj.verified !== true)
		return true;
	return false;
}

function successfulToolNames(
	telemetry: Pick<AnswerTelemetry, "toolCall" | "toolCalls"> | undefined,
): Set<string> {
	const names = new Set<string>();
	const calls =
		telemetry?.toolCalls ??
		(telemetry?.toolCall ? [{ ...telemetry.toolCall }] : []);
	for (const call of calls) {
		if (!call || ("error" in call && call.error)) continue;
		if (isBlockingToolResult(call.name, call.result)) continue;
		names.add(call.name);
	}
	return names;
}

function historyHasPendingKyc(
	history: ExchangePolicyGuardInput["history"],
): boolean {
	if (!history) return false;
	for (const item of [...history].reverse()) {
		if (item.role !== "assistant" && item.role !== "human") continue;
		if (KYC_VERIFIED_RE.test(item.text)) return false;
		if (KYC_REQUEST_RE.test(item.text)) return true;
	}
	return false;
}

function hasVerifiedKyc(
	input: ExchangePolicyGuardInput,
	tools: Set<string>,
): boolean {
	if (tools.has("check_exchange_verification")) return true;
	if (input.state?.verification?.verified === true) return true;
	if (input.state?.order?.verificationId) return true;
	return false;
}

function hasVerifiedPayment(
	input: ExchangePolicyGuardInput,
	tools: Set<string>,
): boolean {
	if (tools.has("verify_exchange_payment")) return true;
	return input.state?.order?.paymentVerified === true;
}

function hasIssuedPayout(
	input: ExchangePolicyGuardInput,
	tools: Set<string>,
): boolean {
	if (tools.has("issue_exchange_payout")) return true;
	const order = input.state?.order;
	return (
		order?.payoutCompleted === true ||
		order?.payoutReady === true ||
		order?.payoutCodeIssued === true
	);
}

function hasPendingKyc(input: ExchangePolicyGuardInput): boolean {
	const stageSlug = input.state?.stageSlug ?? input.stageSlug;
	if (input.state?.verification?.needsVerification === true) return true;
	return (
		KYC_PENDING_STAGES.has(stageSlug ?? "") ||
		historyHasPendingKyc(input.history)
	);
}

export function guardExchangePolicy(
	input: ExchangePolicyGuardInput,
): ExchangePolicyGuardResult {
	const base = guardExchangeReply(input);
	if (!base.ok) return base;

	const text = base.text.trim();
	if (!text) return { ok: true, text };

	const tools = successfulToolNames(input.telemetry);

	if (KYC_VERIFIED_RE.test(text) && !hasVerifiedKyc(input, tools)) {
		return {
			ok: false,
			text: EXCHANGE_KYC_FALLBACK,
			reason: "kyc_auto_verified",
		};
	}

	if (PAYMENT_VERIFIED_RE.test(text) && !hasVerifiedPayment(input, tools)) {
		return {
			ok: false,
			text: EXCHANGE_PAYMENT_FALLBACK,
			reason: "payment_auto_verified",
		};
	}

	if (PAYOUT_COMPLETED_RE.test(text) && !hasIssuedPayout(input, tools)) {
		return {
			ok: false,
			text: EXCHANGE_PAYOUT_FALLBACK,
			reason: "payout_auto_completed",
		};
	}

	if (hasPendingKyc(input) && CONCRETE_REQUISITES_OR_PAYMENT_RE.test(text)) {
		return {
			ok: false,
			text: EXCHANGE_SAFE_FALLBACK,
			reason: "requisites_while_kyc_pending",
		};
	}

	return { ok: true, text };
}
