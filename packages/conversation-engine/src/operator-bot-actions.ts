export type OperatorBotActionKind = "takeover" | "return_ai";
export type OperatorBotPreviewAction = "send" | "cancel";
export type OperatorBotExchangeAction =
	| "kyc_approved"
	| "kyc_request_materials"
	| "kyc_rejected"
	| "payment_under_review"
	| "payment_confirmed"
	| "payment_problem"
	| "payout_ready"
	| "office_details"
	| "operator_reply";

export interface OperatorBotActionCallback {
	action: OperatorBotActionKind;
	conversationId: number;
}

export interface OperatorBotPreviewCallback {
	action: OperatorBotPreviewAction;
	draftId: string;
}

export interface OperatorBotExchangeActionCallback {
	action: OperatorBotExchangeAction;
	conversationId: number;
	orderId?: number;
}

const ACTION_TO_CODE: Record<OperatorBotActionKind, string> = {
	takeover: "take",
	return_ai: "ai",
};

const CODE_TO_ACTION: Record<string, OperatorBotActionKind> = {
	take: "takeover",
	ai: "return_ai",
};

const PREVIEW_ACTION_TO_CODE: Record<OperatorBotPreviewAction, string> = {
	send: "s",
	cancel: "c",
};

const CODE_TO_PREVIEW_ACTION: Record<string, OperatorBotPreviewAction> = {
	s: "send",
	c: "cancel",
};

const EXCHANGE_ACTION_TO_CODE: Record<OperatorBotExchangeAction, string> = {
	kyc_approved: "kycok",
	kyc_request_materials: "kycmore",
	kyc_rejected: "kycno",
	payment_under_review: "paywait",
	payment_confirmed: "payok",
	payment_problem: "paybad",
	payout_ready: "payout",
	office_details: "office",
	operator_reply: "reply",
};

const CODE_TO_EXCHANGE_ACTION: Record<string, OperatorBotExchangeAction> = {
	kycok: "kyc_approved",
	kycmore: "kyc_request_materials",
	kycno: "kyc_rejected",
	paywait: "payment_under_review",
	payok: "payment_confirmed",
	paybad: "payment_problem",
	payout: "payout_ready",
	office: "office_details",
	reply: "operator_reply",
};

export function operatorActionCallbackData(
	action: OperatorBotActionKind,
	conversationId: number,
): string {
	return `op:${ACTION_TO_CODE[action]}:${conversationId}`;
}

export function parseOperatorActionCallback(
	data: string | undefined | null,
): OperatorBotActionCallback | null {
	if (!data) return null;
	const [prefix, code, rawConversationId, extra] = data.split(":");
	if (prefix !== "op" || extra !== undefined) return null;
	const action = code ? CODE_TO_ACTION[code] : undefined;
	if (!action) return null;
	const conversationId = Number.parseInt(rawConversationId ?? "", 10);
	if (!Number.isFinite(conversationId) || conversationId <= 0) return null;
	return { action, conversationId };
}

export function operatorPreviewCallbackData(
	action: OperatorBotPreviewAction,
	draftId: string,
): string {
	return `opm:${PREVIEW_ACTION_TO_CODE[action]}:${draftId}`;
}

export function parseOperatorPreviewCallback(
	data: string | undefined | null,
): OperatorBotPreviewCallback | null {
	if (!data) return null;
	const [prefix, code, draftId, extra] = data.split(":");
	if (prefix !== "opm" || extra !== undefined) return null;
	const action = code ? CODE_TO_PREVIEW_ACTION[code] : undefined;
	if (!action || !draftId || !/^[a-z0-9]{6,16}$/.test(draftId)) return null;
	return { action, draftId };
}

export function operatorExchangeActionCallbackData(
	action: OperatorBotExchangeAction,
	conversationId: number,
	orderId?: number | null,
): string {
	const base = `opx:${EXCHANGE_ACTION_TO_CODE[action]}:${conversationId}`;
	return orderId && Number.isFinite(orderId) && orderId > 0
		? `${base}:${orderId}`
		: base;
}

export function parseOperatorExchangeActionCallback(
	data: string | undefined | null,
): OperatorBotExchangeActionCallback | null {
	if (!data) return null;
	const [prefix, code, rawConversationId, rawOrderId, extra] = data.split(":");
	if (prefix !== "opx" || extra !== undefined) return null;
	const action = code ? CODE_TO_EXCHANGE_ACTION[code] : undefined;
	if (!action) return null;
	const conversationId = Number.parseInt(rawConversationId ?? "", 10);
	if (!Number.isFinite(conversationId) || conversationId <= 0) return null;
	if (!rawOrderId) return { action, conversationId };
	const orderId = Number.parseInt(rawOrderId, 10);
	if (!Number.isFinite(orderId) || orderId <= 0) return null;
	return { action, conversationId, orderId };
}
