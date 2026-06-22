// Unit (без PG) для exchange-side-effects: чистые транзакционные операции над
// exchange_orders. tx фейкается queue-узлом (chainable + thenable), отдающим
// результаты последовательных запросов; .update() — no-op, фиксируем вызовы.

import { describe, expect, it } from "bun:test";
import type { Db } from "./dal/types.ts";
import {
  advanceExchangeLeadAfterKycApproved,
  applyExchangeDraftSideEffects,
  applyKycDecisionSideEffect,
  applyOfficeDetailsSideEffect,
  applyPaymentConfirmedSideEffect,
  applyPayoutReadySideEffect,
  createPayoutCode,
  findExchangeOrderForDraft,
  metadataOrderId,
  numericMetadata,
} from "./exchange-side-effects.ts";
import type { PendingOperatorDraft } from "./operator-bot-shared.ts";

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

// Расширенный fake-tx для KYC-цепочек: select-результаты из очереди (.limit),
// update.set / insert.values копятся. update().set().where() и insert().values()
// просто резолвятся (await не-thenable → значение).
function kycTx(limits: unknown[][]) {
  const q = [...limits];
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const node: Record<string, unknown> = {
    select: () => node,
    from: () => node,
    leftJoin: () => node,
    innerJoin: () => node,
    where: () => node,
    orderBy: () => node,
    limit: async () => q.shift() ?? [],
    update: () => node,
    set: (p: Record<string, unknown>) => {
      updates.push(p);
      return node;
    },
    insert: () => node,
    values: (v: Record<string, unknown>) => {
      inserts.push(v);
      return node;
    },
  };
  return { tx: node as unknown as Db, updates, inserts };
}

describe("applyExchangeDraftSideEffects (dispatcher)", () => {
  it("неизвестный action → null", async () => {
    const { tx } = kycTx([]);
    expect(await applyExchangeDraftSideEffects(tx, draft(), 100, 7)).toBeNull();
  });
  it("payment_confirmed → делегирует (order не найден)", async () => {
    const { tx } = kycTx([[]]);
    const r = await applyExchangeDraftSideEffects(
      tx,
      draft({ exchangeAction: "payment_confirmed" }),
      100,
      7,
    );
    expect(r).toMatchObject({ action: "payment_confirmed", orderFound: false });
  });
  it("kyc_approved → роутится в applyKycDecisionSideEffect", async () => {
    const { tx } = kycTx([[]]); // contact не найден → ранний выход
    const r = await applyExchangeDraftSideEffects(
      tx,
      draft({ exchangeAction: "kyc_approved" }),
      100,
      7,
    );
    expect(r).toMatchObject({ action: "kyc_approved", contactFound: false });
  });
});

describe("applyKycDecisionSideEffect", () => {
  it("контакт не найден → contactFound:false", async () => {
    const { tx } = kycTx([[]]);
    const r = await applyKycDecisionSideEffect(tx, draft(), 100, 7, "kyc_approved");
    expect(r).toMatchObject({ contactFound: false, statusPatched: false });
  });

  it("kyc_rejected → patch контакта, без lead-advance", async () => {
    const { tx, updates } = kycTx([
      [{ attributesJson: "{}" }], // contact
      [], // findExchangeOrderForDraft → нет заявки
    ]);
    const r = await applyKycDecisionSideEffect(tx, draft(), 100, 7, "kyc_rejected");
    expect(r).toMatchObject({ status: "rejected", verified: false, statusPatched: true });
    expect(r.leadAdvance).toBeUndefined();
    // первый update — contacts с attributesJson
    expect(updates[0]?.attributesJson).toBeDefined();
  });

  it("kyc_approved + заявка + lead → verificationId, patch заявки, advance", async () => {
    const { tx, updates } = kycTx([
      [{ attributesJson: "{}" }], // contact
      [{ id: 77, status: "quote", verificationId: null, leadId: 9 }], // findOrder
      [
        {
          id: 9,
          state: "verification_check",
          stageDefinitionId: 1,
          stageSlug: "verification_check",
          stageFunnelId: 50,
          stagePosition: 1,
          stageNextStages: ["risk_review"],
        },
      ], // lead
      [{ id: 2, slug: "risk_review", position: 5 }], // target stage
    ]);
    const r = await applyKycDecisionSideEffect(tx, draft(), 1000, 7, "kyc_approved");
    expect(r).toMatchObject({ verified: true, statusPatched: true, orderId: 77 });
    expect(typeof r.verificationId).toBe("string");
    expect((r.leadAdvance as Record<string, unknown>)?.advanced).toBe(true);
    // update заявки (verificationId) присутствует
    expect(updates.some((u) => "verificationId" in u)).toBe(true);
  });
});

describe("advanceExchangeLeadAfterKycApproved", () => {
  it("лид не найден → lead_not_found", async () => {
    const { tx } = kycTx([[]]);
    const r = await advanceExchangeLeadAfterKycApproved(tx, draft(), 100, 7, null);
    expect(r).toMatchObject({ advanced: false, reason: "lead_not_found" });
  });

  it("happy: verification_check → risk_review", async () => {
    const { tx, inserts } = kycTx([
      [
        {
          id: 9,
          state: "verification_check",
          stageSlug: "verification_check",
          stageFunnelId: 50,
          stagePosition: 1,
          stageNextStages: ["risk_review"],
        },
      ],
      [{ id: 2, slug: "risk_review", position: 5 }],
    ]);
    const r = await advanceExchangeLeadAfterKycApproved(tx, draft(), 100, 7, 9);
    expect(r).toMatchObject({ advanced: true, toState: "risk_review" });
    expect(inserts[0]?.toState).toBe("risk_review"); // leadEvents
  });

  it("чужая стадия + есть risk_review → recovered", async () => {
    const { tx } = kycTx([
      [{ id: 9, state: "offer", stageSlug: "offer", stageFunnelId: 50, stagePosition: 3 }],
      [{ id: 2, slug: "risk_review" }], // innerJoin target
    ]);
    const r = await advanceExchangeLeadAfterKycApproved(tx, draft(), 100, 7, 9);
    expect(r).toMatchObject({ advanced: true, recovered: true, reason: "recovered_wrong_stage" });
  });

  it("чужая стадия без risk_review → stage_not_eligible", async () => {
    const { tx } = kycTx([
      [{ id: 9, state: "offer", stageSlug: "offer", stageFunnelId: 50, stagePosition: 3 }],
      [], // нет target
    ]);
    const r = await advanceExchangeLeadAfterKycApproved(tx, draft(), 100, 7, 9);
    expect(r).toMatchObject({ advanced: false, reason: "stage_not_eligible" });
  });

  it("transition не разрешён → transition_not_allowed", async () => {
    const { tx } = kycTx([
      [
        {
          id: 9,
          state: "verification_check",
          stageSlug: "verification_check",
          stageFunnelId: 50,
          stagePosition: 1,
          stageNextStages: ["done"], // risk_review нет
        },
      ],
    ]);
    const r = await advanceExchangeLeadAfterKycApproved(tx, draft(), 100, 7, 9);
    expect(r).toMatchObject({ advanced: false, reason: "transition_not_allowed" });
  });

  it("целевая стадия не впереди → target_not_ahead", async () => {
    const { tx } = kycTx([
      [
        {
          id: 9,
          state: "verification_check",
          stageSlug: "verification_check",
          stageFunnelId: 50,
          stagePosition: 9,
          stageNextStages: ["risk_review"],
        },
      ],
      [{ id: 2, slug: "risk_review", position: 5 }], // позади
    ]);
    const r = await advanceExchangeLeadAfterKycApproved(tx, draft(), 100, 7, 9);
    expect(r).toMatchObject({ advanced: false, reason: "target_not_ahead" });
  });
});

describe("остаточные ветки", () => {
  it("dispatcher: payout_ready и office_details роутятся", async () => {
    const a = await applyExchangeDraftSideEffects(
      kycTx([[]]).tx,
      draft({ exchangeAction: "payout_ready" }),
      100,
      7,
    );
    expect(a).toMatchObject({ action: "payout_ready" });
    const b = await applyExchangeDraftSideEffects(
      kycTx([[]]).tx,
      draft({ exchangeAction: "office_details" }),
      100,
      7,
    );
    expect(b).toMatchObject({ action: "office_details" });
  });

  it("applyKycDecisionSideEffect: kyc_request_materials → materials_requested", async () => {
    const { tx } = kycTx([[{ attributesJson: "{}" }], []]);
    const r = await applyKycDecisionSideEffect(tx, draft(), 100, 7, "kyc_request_materials");
    expect(r).toMatchObject({ status: "materials_requested", verified: false });
  });

  it("advance: stageFunnelId null → stage_context_missing", async () => {
    const { tx } = kycTx([
      [
        {
          id: 9,
          state: "verification_check",
          stageSlug: "verification_check",
          stageFunnelId: null,
          stagePosition: null,
          stageNextStages: ["risk_review"],
        },
      ],
    ]);
    const r = await advanceExchangeLeadAfterKycApproved(tx, draft(), 100, 7, 9);
    expect(r).toMatchObject({ advanced: false, reason: "stage_context_missing" });
  });

  it("advance: целевой стадии нет → target_stage_not_found", async () => {
    const { tx } = kycTx([
      [
        {
          id: 9,
          state: "verification_check",
          stageSlug: "verification_check",
          stageFunnelId: 50,
          stagePosition: 1,
          stageNextStages: ["risk_review"],
        },
      ],
      [], // target select пуст
    ]);
    const r = await advanceExchangeLeadAfterKycApproved(tx, draft(), 100, 7, 9);
    expect(r).toMatchObject({ advanced: false, reason: "target_stage_not_found" });
  });
});
