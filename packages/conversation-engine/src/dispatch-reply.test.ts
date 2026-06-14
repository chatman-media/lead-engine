// Unit-test для generateReplyAndEnqueue. Проверяет contract:
//   - mediaOnly → early-return (0 envelopes, replyStrategy не вызван)
//   - userMessageText="" → early-return
//   - replyStrategy returns null/[] → 0 envelopes
//   - happy path: replyStrategy returns N envelopes → outbound.enqueue × N
//
// Postgres не нужен — мокаем db.transaction через TestDb shim, который
// просто исполняет callback. Тест покрывает orchestration, не DAL-уровень.

import type {
  Inbound,
  OperatorHandoffMeta,
  OutboundEnvelope,
} from "@chatman-media/channel-core";
import { describe, expect, it } from "bun:test";
import { generateReplyAndEnqueue } from "./dispatch-reply.ts";
import type { Db } from "./dal/types.ts";
import type { ProcessInboundResult } from "./types.ts";

interface TestDb {
  transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  execute: (sql: unknown) => Promise<unknown>;
}

function makeTestDb(): TestDb {
  return {
    transaction: async (fn) => fn({} as unknown as Db),
    execute: async () => undefined,
  };
}

function fakeInbound(): Inbound {
  return {
    channelId: "1",
    externalMessageId: "msg-1",
    externalUserId: "user-1",
    receivedAt: 0,
    parts: [{ kind: "text", text: "hello" }],
    raw: {},
  };
}

function handoff(): OperatorHandoffMeta {
  return {
    reason: "payment_review",
    title: "Проверить оплату",
    action: "Сверить чек",
    orderId: 77,
    stageSlug: "payment_proof_waiting",
  };
}

function makeAutoHandoffDb() {
  const conversation = { mode: "ai", status: "open", escalatedAt: null as number | null };
  const messages: Record<string, unknown>[] = [];
  const outbound: Record<string, unknown>[] = [];
  const audit: Record<string, unknown>[] = [];
  const tx = {
    execute: async () => undefined,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [conversation],
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        // Применяем только примитивы: SQL-шаблоны (bumpFallbackStreak) пропускаем.
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            (conversation as Record<string, unknown>)[k] = v;
          }
        }
        return { where: () => ({ returning: async () => [conversation] }) };
      },
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        if ("action" in row) audit.push(row);
        else if ("payloadJson" in row) outbound.push(row);
        else messages.push(row);
        return {
          returning: async () => [{ id: messages.length + outbound.length + audit.length, ...row }],
        };
      },
    }),
  };
  return {
    db: {
      transaction: async <T>(fn: (inner: Db) => Promise<T>) =>
        fn(tx as unknown as Db),
      execute: async () => undefined,
    } as unknown as Db,
    conversation,
    messages,
    outbound,
    audit,
  };
}

const tenant = { tenantId: 1, slug: "t1", llmBillingMode: "byok" as const };
const channel = {
  channelId: 100,
  kind: "telegram_bot" as const,
  externalId: "test-bot",
};

describe("generateReplyAndEnqueue", () => {
  it("mediaOnly → no LLM call, 0 envelopes", async () => {
    let strategyCalled = false;
    const db = makeTestDb();
    const result: ProcessInboundResult = {
      contactId: 1,
      conversationId: 10,
      persisted: true,
      outboundEnqueued: 0,
      userMessageText: "",
      mediaOnly: true,
      replyDeferred: true,
    };
    const out = await generateReplyAndEnqueue({
      db: db as unknown as Db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      result,
      replyStrategy: {
        async generate() {
          strategyCalled = true;
          return [{ channelId: "1", externalUserId: "u1", parts: [] }];
        },
      },
    });
    expect(out.outboundEnqueued).toBe(0);
    expect(strategyCalled).toBe(false);
  });

  it("empty userMessageText → no LLM call, 0 envelopes", async () => {
    let strategyCalled = false;
    const db = makeTestDb();
    const out = await generateReplyAndEnqueue({
      db: db as unknown as Db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          strategyCalled = true;
          return [];
        },
      },
    });
    expect(out.outboundEnqueued).toBe(0);
    expect(strategyCalled).toBe(false);
  });

  it("replyStrategy returns null → 0 envelopes (tx не открывается)", async () => {
    let txOpened = false;
    const db: TestDb = {
      transaction: async (fn) => {
        txOpened = true;
        return fn({} as unknown as Db);
      },
      execute: async () => undefined,
    };
    const out = await generateReplyAndEnqueue({
      db: db as unknown as Db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "hello",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return null;
        },
      },
    });
    expect(out.outboundEnqueued).toBe(0);
    // Главный invariant: НЕТ открытой DB tx при пустом результате LLM.
    expect(txOpened).toBe(false);
  });

  it("auto handoff with customer notice → enqueue fallback, audit and mode=human", async () => {
    const db = makeAutoHandoffDb();
    const notifications: Array<Record<string, unknown>> = [];
    const out = await generateReplyAndEnqueue({
      db: db.db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "чек",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return {
            envelopes: [
              {
                channelId: "100",
                externalUserId: "user-1",
                parts: [{ kind: "text", text: "Передаю оператору." }],
              },
            ],
            operatorHandoffs: [handoff()],
            autoTakeover: true,
            customerNoticeSent: true,
          };
        },
      },
      notifications: {
        notify: async (event: Record<string, unknown>) => {
          notifications.push(event);
        },
      } as never,
    });

    expect(out).toMatchObject({ outboundEnqueued: 1, escalatedReason: "payment_review" });
    expect(db.conversation).toMatchObject({
      mode: "human",
      status: "pending",
      escalatedAt: expect.any(Number),
    });
    expect(db.messages).toHaveLength(1);
    expect(db.outbound).toHaveLength(1);
    expect(db.audit[0]?.action).toBe("conversation.mode.auto_handoff");
    expect(JSON.parse(String(db.audit[0]?.detailsJson))).toMatchObject({
      reason: "payment_review",
      orderId: 77,
      stageSlug: "payment_proof_waiting",
      customerNoticeSent: true,
    });
    expect(notifications).toHaveLength(1);
  });

  it("auto handoff without customer notice → no outbound/message, audit and mode=human", async () => {
    const db = makeAutoHandoffDb();
    const out = await generateReplyAndEnqueue({
      db: db.db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "чек",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return {
            envelopes: [],
            operatorHandoffs: [handoff()],
            autoTakeover: true,
            customerNoticeSent: false,
          };
        },
      },
    });

    expect(out).toMatchObject({ outboundEnqueued: 0, escalatedReason: "payment_review" });
    expect(db.conversation).toMatchObject({
      mode: "human",
      status: "pending",
      escalatedAt: expect.any(Number),
    });
    expect(db.messages).toHaveLength(0);
    expect(db.outbound).toHaveLength(0);
    expect(db.audit[0]?.action).toBe("conversation.mode.auto_handoff");
    expect(JSON.parse(String(db.audit[0]?.detailsJson))).toMatchObject({
      reason: "payment_review",
      customerNoticeSent: false,
    });
  });

  it("contract: LLM call происходит ВНЕ db.transaction", async () => {
    // Сценарий: replyStrategy.generate должен быть вызван ДО db.transaction.
    // Мы регистрируем порядок вызовов и сверяем.
    const events: string[] = [];
    const replyEnvelopes: OutboundEnvelope[] = [
      { channelId: "100", externalUserId: "u1", parts: [{ kind: "text", text: "ответ" }] },
    ];
    const db: TestDb = {
      transaction: async (fn) => {
        events.push("tx-open");
        const out = await fn({
          insert: () => ({ values: () => ({ returning: async () => [{ id: 99 }] }) }),
          update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
          select: () => ({ from: () => ({ where: async () => [] }) }),
          execute: async () => [],
        } as unknown as Db);
        events.push("tx-commit");
        return out;
      },
      execute: async () => undefined,
    };
    const out = await generateReplyAndEnqueue({
      db: db as unknown as Db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "hello",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          events.push("llm-call");
          return replyEnvelopes;
        },
      },
    });
    // КЛЮЧЕВОЙ инвариант split'а: llm-call ДО tx-open.
    expect(events.indexOf("llm-call")).toBeLessThan(events.indexOf("tx-open"));
    // Tx должна была открыться один раз (для enqueue).
    expect(events.filter((e) => e === "tx-open")).toHaveLength(1);
    // outboundEnqueued = 1 (n envelopes отправлено)
    expect(out.outboundEnqueued).toBe(1);
  });
});
