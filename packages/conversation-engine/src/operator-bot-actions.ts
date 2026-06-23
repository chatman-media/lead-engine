export const OPERATOR_ACTION_CALLBACK_PREFIX = "op:v1";

export type OperatorBotActionKind = "takeover" | "return_ai";
export type OperatorBotAction = "open_chat" | OperatorBotActionKind;
export type OperatorConversationModeAction = OperatorBotActionKind;
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

export interface OperatorActionPayload {
  action: OperatorBotAction;
  tenantId: number;
  conversationId: number;
}

export type OperatorActionParseResult =
  | { ok: true; payload: OperatorActionPayload }
  | { ok: false; reason: "not_operator_action" | "malformed" };

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

export function buildOperatorActionCallbackData(payload: OperatorActionPayload): string {
  return [
    "op",
    "v1",
    payload.action,
    String(payload.tenantId),
    String(payload.conversationId),
  ].join(":");
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

export function parseOperatorActionCallbackData(
  data: string | undefined | null,
): OperatorActionParseResult {
  if (!data) {
    return { ok: false, reason: "not_operator_action" };
  }
  const legacy = parseOperatorActionCallback(data);
  if (legacy) {
    return {
      ok: true,
      payload: {
        action: legacy.action,
        tenantId: 0,
        conversationId: legacy.conversationId,
      },
    };
  }
  if (!data.startsWith(OPERATOR_ACTION_CALLBACK_PREFIX)) {
    return { ok: false, reason: "not_operator_action" };
  }
  const [prefix, version, action, rawTenantId, rawConversationId, extra] = data.split(":");
  if (
    prefix !== "op" ||
    version !== "v1" ||
    extra !== undefined ||
    (action !== "open_chat" && action !== "takeover" && action !== "return_ai")
  ) {
    return { ok: false, reason: "malformed" };
  }
  const tenantId = Number.parseInt(rawTenantId ?? "", 10);
  const conversationId = Number.parseInt(rawConversationId ?? "", 10);
  if (
    !Number.isSafeInteger(tenantId) ||
    tenantId <= 0 ||
    !Number.isSafeInteger(conversationId) ||
    conversationId <= 0
  ) {
    return { ok: false, reason: "malformed" };
  }
  return {
    ok: true,
    payload: {
      action,
      tenantId,
      conversationId,
    },
  };
}

export const OPERATOR_BOT_ACTIONS = ["open_chat", "takeover", "return_ai"] as const;

export function isOperatorHandoffEvent(event: {
  eventType: string;
  conversationId?: number;
}): boolean {
  return (
    (event.eventType === "operator_handoff_required" ||
      event.eventType === "operator_confirm_needed" ||
      event.eventType === "human_takeover") &&
    Number.isSafeInteger(event.conversationId) &&
    (event.conversationId ?? 0) > 0
  );
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
  return orderId && Number.isFinite(orderId) && orderId > 0 ? `${base}:${orderId}` : base;
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
