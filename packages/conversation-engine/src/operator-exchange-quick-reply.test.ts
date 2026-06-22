// Unit (без PG) для резолверов exchange-quick-reply. withTenant=db.transaction;
// queue-tx отдаёт строки select по очереди.

import { describe, expect, it } from "bun:test";
import type { Db } from "./dal/types.ts";
import type { OperatorBotExchangeAction } from "./operator-bot-actions.ts";
import {
  type ExchangeQuickReplyDraft,
  resolveExchangeActionScope,
  resolveExchangeQuickReply,
} from "./operator-exchange-quick-reply.ts";

function fakeDb(limits: unknown[][]): Db {
  const q = [...limits];
  const node: Record<string, unknown> = {
    execute: async () => undefined,
    select: () => node,
    from: () => node,
    where: () => node,
    limit: async () => q.shift() ?? [],
  };
  return {
    transaction: async (cb: (t: unknown) => unknown) => cb(node),
  } as unknown as Db;
}

const qr = (over: Partial<ExchangeQuickReplyDraft> = {}): ExchangeQuickReplyDraft => ({
  title: "T",
  text: "text",
  metadata: { exchangeAction: "payout_ready" },
  ...over,
});

describe("resolveExchangeActionScope", () => {
  it("нет db → ready", async () => {
    expect(await resolveExchangeActionScope(undefined, { tenantId: 1, conversationId: 5 })).toEqual(
      {
        kind: "ready",
      },
    );
  });
  it("диалог не найден → blocked", async () => {
    const r = await resolveExchangeActionScope(fakeDb([[]]), { tenantId: 1, conversationId: 5 });
    expect(r).toEqual({ kind: "blocked", toast: "Диалог не найден" });
  });
  it("без orderId → ready", async () => {
    const r = await resolveExchangeActionScope(fakeDb([[{ id: 5 }]]), {
      tenantId: 1,
      conversationId: 5,
    });
    expect(r).toEqual({ kind: "ready" });
  });
  it("orderId есть, заявка не найдена → blocked", async () => {
    const r = await resolveExchangeActionScope(fakeDb([[{ id: 5 }], []]), {
      tenantId: 1,
      conversationId: 5,
      orderId: 9,
    });
    expect(r).toEqual({ kind: "blocked", toast: "Заявка не найдена" });
  });
  it("диалог + заявка есть → ready", async () => {
    const r = await resolveExchangeActionScope(fakeDb([[{ id: 5 }], [{ id: 9 }]]), {
      tenantId: 1,
      conversationId: 5,
      orderId: 9,
    });
    expect(r).toEqual({ kind: "ready" });
  });
});

describe("resolveExchangeQuickReply", () => {
  const base = (action: OperatorBotExchangeAction, orderId?: number) => ({
    tenantId: 1,
    conversationId: 5,
    orderId,
    action,
    quickReply: qr(),
    now: 1000,
  });

  it("нет orderId → passthrough", async () => {
    const r = await resolveExchangeQuickReply(fakeDb([]), base("payout_ready"));
    expect(r).toMatchObject({ kind: "ready" });
  });

  it("office_details: заявка есть → текст с офисом", async () => {
    const r = await resolveExchangeQuickReply(
      fakeDb([[{ id: 9, payoutLocation: "BKK office", payoutDestinationJson: null }]]),
      base("office_details", 9),
    );
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") expect(r.quickReply.text).toContain("BKK office");
  });

  it("office_details: заявка не найдена → blocked", async () => {
    const r = await resolveExchangeQuickReply(fakeDb([[]]), base("office_details", 9));
    expect(r).toEqual({ kind: "blocked", toast: "Заявка не найдена" });
  });

  it("payout_ready: paid → код выдачи в тексте", async () => {
    const r = await resolveExchangeQuickReply(
      fakeDb([[{ id: 9, status: "paid", payoutCode: null, payoutCodeExpiresAt: null }]]),
      base("payout_ready", 9),
    );
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect(r.quickReply.text).toMatch(/Код выдачи: CODE-9-/);
      expect(r.quickReply.metadata.payoutCodeGenerated).toBe(true);
    }
  });

  it("payout_ready: неподходящий статус → blocked", async () => {
    const r = await resolveExchangeQuickReply(
      fakeDb([[{ id: 9, status: "new" }]]),
      base("payout_ready", 9),
    );
    expect(r.kind).toBe("blocked");
  });

  it("прочий action с orderId → passthrough", async () => {
    const r = await resolveExchangeQuickReply(fakeDb([]), base("kyc_approved", 9));
    expect(r).toMatchObject({ kind: "ready" });
  });
});
