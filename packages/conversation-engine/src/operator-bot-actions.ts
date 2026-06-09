import type { NotificationEvent } from "./notifications.ts";

export const OPERATOR_ACTION_CALLBACK_PREFIX = "op:v1";

export const OPERATOR_BOT_ACTIONS = ["open_chat", "takeover", "return_ai"] as const;
export type OperatorBotAction = (typeof OPERATOR_BOT_ACTIONS)[number];

export type OperatorConversationModeAction = Extract<
  OperatorBotAction,
  "takeover" | "return_ai"
>;

export interface OperatorActionPayload {
  action: OperatorBotAction;
  tenantId: number;
  conversationId: number;
}

export type OperatorActionParseResult =
  | { ok: true; payload: OperatorActionPayload }
  | { ok: false; reason: "not_operator_action" | "malformed" };

const OPERATOR_HANDOFF_EVENTS = new Set([
  "operator_handoff_required",
  "operator_confirm_needed",
  "human_takeover",
]);

function positiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
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

export function parseOperatorActionCallbackData(data: string | undefined): OperatorActionParseResult {
  if (!data?.startsWith(OPERATOR_ACTION_CALLBACK_PREFIX)) {
    return { ok: false, reason: "not_operator_action" };
  }
  const [scope, version, action, tenantRaw, conversationRaw] = data.split(":");
  if (scope !== "op" || version !== "v1") return { ok: false, reason: "malformed" };
  if (!OPERATOR_BOT_ACTIONS.includes(action as OperatorBotAction)) {
    return { ok: false, reason: "malformed" };
  }
  const tenantId = positiveInt(tenantRaw ?? "");
  const conversationId = positiveInt(conversationRaw ?? "");
  if (!tenantId || !conversationId) return { ok: false, reason: "malformed" };
  return {
    ok: true,
    payload: {
      action: action as OperatorBotAction,
      tenantId,
      conversationId,
    },
  };
}

export function isOperatorHandoffEvent(event: NotificationEvent): boolean {
  return (
    OPERATOR_HANDOFF_EVENTS.has(event.eventType) &&
    Number.isSafeInteger(event.conversationId) &&
    (event.conversationId ?? 0) > 0
  );
}
