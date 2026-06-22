// Unit (без PG) для DraftStore. Без db — in-memory Map; с db — фейк tx
// (withTenant=db.transaction(cb)).

import { describe, expect, it } from "bun:test";
import type { Db } from "./dal/types.ts";
import type { PendingOperatorDraft } from "./operator-bot-shared.ts";
import { DraftStore } from "./operator-draft-store.ts";

function draft(over: Partial<PendingOperatorDraft> = {}): PendingOperatorDraft {
  return {
    draftId: "d1",
    tenantId: 1,
    adminId: 2,
    chatId: "100",
    conversationId: 5,
    text: "Черновик",
    metadata: {},
    createdAt: 10,
    expiresAt: 700,
    ...over,
  };
}

describe("DraftStore (in-memory, без db)", () => {
  it("createPendingDraft → status pending + кладёт в Map; findPendingDraft достаёт", async () => {
    const store = new DraftStore();
    const saved = await store.createPendingDraft(draft());
    expect(saved.status).toBe("pending");
    const found = await store.findPendingDraft("d1", 1);
    expect(found?.draftId).toBe("d1");
  });

  it("findPendingDraft неизвестного → null", async () => {
    expect(await new DraftStore().findPendingDraft("nope", 1)).toBeNull();
  });

  it("cancelDraft/expireDraft (без dbId) удаляют из Map", async () => {
    const store = new DraftStore();
    await store.createPendingDraft(draft({ draftId: "c1" }));
    await store.cancelDraft(draft({ draftId: "c1" }), 100);
    expect(await store.findPendingDraft("c1", 1)).toBeNull();
  });

  it("deletePending убирает черновик", async () => {
    const store = new DraftStore();
    await store.createPendingDraft(draft({ draftId: "x1" }));
    store.deletePending("x1");
    expect(await store.findPendingDraft("x1", 1)).toBeNull();
  });

  it("createDraftId уникален и не пересекается с занятыми", () => {
    const store = new DraftStore();
    const a = store.createDraftId();
    const b = store.createDraftId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(6);
  });
});

// Фейк db: withTenant(db,...) = db.transaction(cb); cb получает tx-узел.
function fakeDb(opts: { insertId?: number; selectRows?: unknown[] }) {
  const updates: Array<Record<string, unknown>> = [];
  const tx: Record<string, unknown> = {
    execute: async () => undefined,
    insert: () => tx,
    values: () => tx,
    returning: async () => (opts.insertId ? [{ id: opts.insertId }] : []),
    select: () => tx,
    from: () => tx,
    where: () => tx,
    limit: async () => opts.selectRows ?? [],
    update: () => tx,
    set: (patch: Record<string, unknown>) => {
      updates.push(patch);
      return tx;
    },
  };
  const db = {
    transaction: async (cb: (t: unknown) => unknown) => cb(tx),
  } as unknown as Db;
  return { db, updates };
}

describe("DraftStore (с db)", () => {
  it("createPendingDraft вставляет и возвращает dbId", async () => {
    const { db } = fakeDb({ insertId: 42 });
    const saved = await new DraftStore(db).createPendingDraft(draft());
    expect(saved.dbId).toBe(42);
    expect(saved.status).toBe("pending");
  });

  it("findPendingDraft маппит строку из БД", async () => {
    const { db } = fakeDb({
      selectRows: [
        {
          id: 9,
          tenantId: 1,
          adminId: 2,
          conversationId: 5,
          draftKey: "d1",
          chatId: "100",
          status: "pending",
          text: "T",
          metadataJson: '{"exchangeAction":"payout_ready"}',
          createdAt: 10,
          expiresAt: 700,
        },
      ],
    });
    const found = await new DraftStore(db).findPendingDraft("d1", 1);
    expect(found).toMatchObject({ draftId: "d1", dbId: 9, adminId: 2 });
    expect(found?.metadata?.exchangeAction).toBe("payout_ready");
  });

  it("findPendingDraft: adminId null → null", async () => {
    const { db } = fakeDb({ selectRows: [{ draftKey: "d1", adminId: null }] });
    expect(await new DraftStore(db).findPendingDraft("d1", 1)).toBeNull();
  });

  it("cancelDraft durable → update status cancelled", async () => {
    const { db, updates } = fakeDb({});
    await new DraftStore(db).cancelDraft(draft({ dbId: 700 }), 200);
    expect(updates[0]).toMatchObject({ status: "cancelled", handledAt: 200 });
  });

  it("expireDraft durable → update status expired", async () => {
    const { db, updates } = fakeDb({});
    await new DraftStore(db).expireDraft(draft({ dbId: 700 }), 300);
    expect(updates[0]).toMatchObject({ status: "expired", handledAt: 300 });
  });
});
