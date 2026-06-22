// Unit (без PG) для exchange-side-effects: чистые транзакционные операции над
// exchange_orders. tx фейкается queue-узлом (chainable + thenable), отдающим
// результаты последовательных запросов; .update() — no-op, фиксируем вызовы.

import { describe, expect, it } from "bun:test";
import type { Db } from "./dal/types.ts";
import {
  applyOfficeDetailsSideEffect,
  applyPaymentConfirmedSideEffect,
  applyPayoutReadySideEffect,
  createPayoutCode,
  findExchangeOrderForDraft,
  metadataOrderId,
  numericMetadata,
} from "./exchange-side-effects.ts";
import type { PendingOperatorDraft } from "./operator-bot-handler.ts";

function draft(metadata: Record<string, unknown> = {}): PendingOperatorDraft {
  return {
    draftId: "d1",
    tenantId: 1,
    adminId: 2,
    chatId: "100",
    conversationId: 5,
    text: "ok",
    metadata,
    createdAt: 0,
    expiresAt: 0,
  };
}

// queue-tx: select-цепочки отдают массивы из очереди; update() копит вызовы.
function fakeTx(selects: unknown[][]) {
  const q = [...selects];
  const updates: Array<Record<string, unknown>> = [];
  const node: Record<string, unknown> = {
    select: () => node,
    from: () => node,
    where: () => node,
    orderBy: () => node,
    limit: async () => q.shift() ?? [],
    update: () => node,
    set: (patch: Record<string, unknown>) => {
      updates.push(patch);
      return node;
    },
  };
  return { tx: node as unknown as Db, updates };
}

describe("metadataOrderId / numericMetadata", () => {
  it("metadataOrderId: число/строка/мусор", () => {
    expect(metadataOrderId({ orderId: 7 })).toBe(7);
    expect(metadataOrderId({ orderId: "9" })).toBe(9);
    expect(metadataOrderId({ orderId: 0 })).toBeNull();
    expect(metadataOrderId({ orderId: "abc" })).toBeNull();
    expect(metadataOrderId({})).toBeNull();
    expect(metadataOrderId(undefined)).toBeNull();
  });
  it("numericMetadata: число/строка/мусор", () => {
    expect(numericMetadata(12.7)).toBe(12);
    expect(numericMetadata("8")).toBe(8);
    expect(numericMetadata(0)).toBeNull();
    expect(numericMetadata("x")).toBeNull();
    expect(numericMetadata(null)).toBeNull();
  });
});

describe("createPayoutCode", () => {
  it("формат CODE-<orderId>-<suffix>", () => {
    expect(createPayoutCode(42)).toMatch(/^CODE-42-[A-Z0-9]{6}$/);
  });
});

describe("findExchangeOrderForDraft", () => {
  it("по orderId из metadata", async () => {
    const { tx } = fakeTx([[{ id: 11, status: "new" }]]);
    const order = await findExchangeOrderForDraft(tx, draft({ orderId: 11 }));
    expect(order?.id).toBe(11);
  });
  it("без orderId → последний по createdAt", async () => {
    const { tx } = fakeTx([[{ id: 22, status: "paid" }]]);
    const order = await findExchangeOrderForDraft(tx, draft());
    expect(order?.id).toBe(22);
  });
  it("ничего не найдено → null", async () => {
    const { tx } = fakeTx([[]]);
    expect(await findExchangeOrderForDraft(tx, draft())).toBeNull();
  });
});

describe("applyPaymentConfirmedSideEffect", () => {
  it("заявки нет → orderFound:false", async () => {
    const { tx, updates } = fakeTx([[]]);
    const r = await applyPaymentConfirmedSideEffect(tx, draft({ orderId: 5 }), 100);
    expect(r).toMatchObject({
      action: "payment_confirmed",
      orderFound: false,
      statusPatched: false,
    });
    expect(updates).toHaveLength(0);
  });
  it("терминальный статус → не патчим", async () => {
    const { tx, updates } = fakeTx([[{ id: 5, status: "completed" }]]);
    const r = await applyPaymentConfirmedSideEffect(tx, draft(), 100);
    expect(r).toMatchObject({ statusPatched: false, previousStatus: "completed" });
    expect(updates).toHaveLength(0);
  });
  it("активный статус → статус paid", async () => {
    const { tx, updates } = fakeTx([[{ id: 5, status: "new" }]]);
    const r = await applyPaymentConfirmedSideEffect(tx, draft(), 100);
    expect(r).toMatchObject({ nextStatus: "paid", statusPatched: true });
    expect(updates[0]).toMatchObject({ status: "paid", updatedAt: 100 });
  });
});

describe("applyPayoutReadySideEffect", () => {
  it("заявки нет → orderFound:false", async () => {
    const { tx } = fakeTx([[]]);
    const r = await applyPayoutReadySideEffect(tx, draft({ orderId: 5 }), 100);
    expect(r).toMatchObject({ action: "payout_ready", orderFound: false });
  });
  it("неподходящий статус → invalid_status", async () => {
    const { tx } = fakeTx([[{ id: 5, status: "new" }]]);
    const r = await applyPayoutReadySideEffect(tx, draft(), 100);
    expect(r).toMatchObject({ statusPatched: false, reason: "invalid_status" });
  });
  it("paid → payout + сгенерён код выдачи", async () => {
    const { tx, updates } = fakeTx([
      [{ id: 5, status: "paid", payoutCode: null, payoutCodeExpiresAt: null }],
    ]);
    const r = await applyPayoutReadySideEffect(tx, draft(), 1000);
    expect(r).toMatchObject({ nextStatus: "payout", payoutCodeIssued: true, statusPatched: true });
    expect(updates[0]?.status).toBe("payout");
    expect(String(updates[0]?.payoutCode)).toMatch(/^CODE-5-/);
  });
  it("payout с существующим кодом → переиспользует код", async () => {
    const { tx, updates } = fakeTx([
      [
        {
          id: 5,
          status: "payout",
          payoutCode: "CODE-5-ABC123",
          payoutCodeExpiresAt: 9_999_999_999,
        },
      ],
    ]);
    const r = await applyPayoutReadySideEffect(tx, draft(), 1000);
    expect(updates[0]?.payoutCode).toBe("CODE-5-ABC123");
    expect(r.statusPatched).toBe(false); // уже payout
  });
});

describe("applyOfficeDetailsSideEffect", () => {
  it("заявки нет → not_recorded", async () => {
    const { tx } = fakeTx([[]]);
    const r = await applyOfficeDetailsSideEffect(tx, draft({ orderId: 5 }));
    expect(r).toMatchObject({ action: "office_details", confirmationState: "not_recorded" });
  });
  it("заявка есть → operator_confirmed + pickupWindow из metadata", async () => {
    const { tx } = fakeTx([
      [{ id: 5, payoutMethod: "office_cash", payoutLocation: "BKK", payoutDestinationJson: null }],
    ]);
    const r = await applyOfficeDetailsSideEffect(tx, draft({ pickupWindow: "10:00-12:00" }));
    expect(r).toMatchObject({
      confirmationState: "operator_confirmed",
      payoutMethod: "office_cash",
      pickupWindow: "10:00-12:00",
    });
  });
});
