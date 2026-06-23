import { describe, expect, it } from "bun:test";
import {
  buildOperatorActionCallbackData,
  isOperatorHandoffEvent,
  OPERATOR_BOT_ACTIONS,
  operatorActionCallbackData,
  operatorExchangeActionCallbackData,
  operatorPreviewCallbackData,
  parseOperatorActionCallback,
  parseOperatorActionCallbackData,
  parseOperatorExchangeActionCallback,
  parseOperatorPreviewCallback,
} from "./operator-bot-actions.ts";

describe("operatorActionCallbackData", () => {
  it("кодирует takeover/return_ai в компактные коды", () => {
    expect(operatorActionCallbackData("takeover", 5)).toBe("op:take:5");
    expect(operatorActionCallbackData("return_ai", 7)).toBe("op:ai:7");
  });

  it("round-trip через parseOperatorActionCallback", () => {
    const data = operatorActionCallbackData("takeover", 42);
    expect(parseOperatorActionCallback(data)).toEqual({
      action: "takeover",
      conversationId: 42,
    });
  });
});

describe("buildOperatorActionCallbackData", () => {
  it("строит op:v1 payload для каждого действия", () => {
    expect(
      buildOperatorActionCallbackData({
        action: "open_chat",
        tenantId: 3,
        conversationId: 9,
      }),
    ).toBe("op:v1:open_chat:3:9");
    expect(
      buildOperatorActionCallbackData({
        action: "takeover",
        tenantId: 1,
        conversationId: 2,
      }),
    ).toBe("op:v1:takeover:1:2");
    expect(
      buildOperatorActionCallbackData({
        action: "return_ai",
        tenantId: 10,
        conversationId: 20,
      }),
    ).toBe("op:v1:return_ai:10:20");
  });

  it("round-trip через parseOperatorActionCallbackData", () => {
    const data = buildOperatorActionCallbackData({
      action: "open_chat",
      tenantId: 3,
      conversationId: 9,
    });
    expect(parseOperatorActionCallbackData(data)).toEqual({
      ok: true,
      payload: { action: "open_chat", tenantId: 3, conversationId: 9 },
    });
  });
});

describe("parseOperatorActionCallbackData", () => {
  it("пустые данные → not_operator_action", () => {
    expect(parseOperatorActionCallbackData(undefined)).toEqual({
      ok: false,
      reason: "not_operator_action",
    });
    expect(parseOperatorActionCallbackData(null)).toEqual({
      ok: false,
      reason: "not_operator_action",
    });
    expect(parseOperatorActionCallbackData("")).toEqual({
      ok: false,
      reason: "not_operator_action",
    });
  });

  it("чужой prefix → not_operator_action", () => {
    expect(parseOperatorActionCallbackData("lvl:important")).toEqual({
      ok: false,
      reason: "not_operator_action",
    });
  });

  it("legacy op:take/op:ai парсится с tenantId=0", () => {
    expect(parseOperatorActionCallbackData("op:take:12")).toEqual({
      ok: true,
      payload: { action: "takeover", tenantId: 0, conversationId: 12 },
    });
    expect(parseOperatorActionCallbackData("op:ai:13")).toEqual({
      ok: true,
      payload: { action: "return_ai", tenantId: 0, conversationId: 13 },
    });
  });

  it("неизвестное действие в op:v1 → malformed", () => {
    expect(parseOperatorActionCallbackData("op:v1:bogus:3:9")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("лишний сегмент → malformed", () => {
    expect(parseOperatorActionCallbackData("op:v1:takeover:3:9:zzz")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("невалидные tenantId/conversationId → malformed", () => {
    expect(parseOperatorActionCallbackData("op:v1:open_chat:abc:9")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseOperatorActionCallbackData("op:v1:open_chat:0:9")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseOperatorActionCallbackData("op:v1:open_chat:3:0")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseOperatorActionCallbackData("op:v1:open_chat:3:xyz")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("валидный op:v1 payload парсится", () => {
    expect(parseOperatorActionCallbackData("op:v1:return_ai:4:8")).toEqual({
      ok: true,
      payload: { action: "return_ai", tenantId: 4, conversationId: 8 },
    });
  });
});

describe("OPERATOR_BOT_ACTIONS", () => {
  it("перечисляет все поддерживаемые действия", () => {
    expect(OPERATOR_BOT_ACTIONS).toEqual(["open_chat", "takeover", "return_ai"]);
  });
});

describe("isOperatorHandoffEvent", () => {
  it("true для handoff-событий с валидным conversationId", () => {
    expect(
      isOperatorHandoffEvent({
        eventType: "operator_handoff_required",
        conversationId: 5,
      }),
    ).toBe(true);
    expect(
      isOperatorHandoffEvent({
        eventType: "operator_confirm_needed",
        conversationId: 5,
      }),
    ).toBe(true);
    expect(
      isOperatorHandoffEvent({
        eventType: "human_takeover",
        conversationId: 5,
      }),
    ).toBe(true);
  });

  it("false для чужих типов событий", () => {
    expect(isOperatorHandoffEvent({ eventType: "lead_created", conversationId: 5 })).toBe(false);
  });

  it("false без валидного conversationId", () => {
    expect(isOperatorHandoffEvent({ eventType: "operator_handoff_required" })).toBe(false);
    expect(
      isOperatorHandoffEvent({
        eventType: "operator_handoff_required",
        conversationId: 0,
      }),
    ).toBe(false);
    expect(
      isOperatorHandoffEvent({
        eventType: "human_takeover",
        conversationId: Number.NaN,
      }),
    ).toBe(false);
  });
});

describe("operatorPreviewCallbackData", () => {
  it("кодирует send/cancel и round-trip'ится", () => {
    expect(operatorPreviewCallbackData("send", "abc123")).toBe("opm:s:abc123");
    expect(operatorPreviewCallbackData("cancel", "abc123")).toBe("opm:c:abc123");
    expect(parseOperatorPreviewCallback("opm:s:abc123")).toEqual({
      action: "send",
      draftId: "abc123",
    });
  });
});

describe("operatorExchangeActionCallbackData", () => {
  it("включает orderId когда он валиден", () => {
    expect(operatorExchangeActionCallbackData("payment_confirmed", 109, 77)).toBe(
      "opx:payok:109:77",
    );
  });

  it("опускает orderId когда он отсутствует или невалиден", () => {
    expect(operatorExchangeActionCallbackData("payout_ready", 109)).toBe("opx:payout:109");
    expect(operatorExchangeActionCallbackData("office_details", 109, null)).toBe("opx:office:109");
    expect(operatorExchangeActionCallbackData("kyc_approved", 109, 0)).toBe("opx:kycok:109");
  });

  it("round-trip через parseOperatorExchangeActionCallback", () => {
    expect(
      parseOperatorExchangeActionCallback(
        operatorExchangeActionCallbackData("operator_reply", 11, 22),
      ),
    ).toEqual({ action: "operator_reply", conversationId: 11, orderId: 22 });
    expect(
      parseOperatorExchangeActionCallback(operatorExchangeActionCallbackData("kyc_rejected", 11)),
    ).toEqual({ action: "kyc_rejected", conversationId: 11 });
  });
});
