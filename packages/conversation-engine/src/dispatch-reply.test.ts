// Unit-test для generateReplyAndEnqueue. Проверяет contract:
//   - mediaOnly → early-return (0 envelopes, replyStrategy не вызван)
//   - userMessageText="" → early-return
//   - replyStrategy returns null/[] → 0 envelopes
//   - happy path: replyStrategy returns N envelopes → outbound.enqueue × N
//
// Postgres не нужен — мокаем db.transaction через TestDb shim, который
// просто исполняет callback. Тест покрывает orchestration, не DAL-уровень.

import { describe, expect, it } from "bun:test";
import type { Inbound, OperatorHandoffMeta, OutboundEnvelope } from "@chatman-media/channel-core";
import type { Db } from "./dal/types.ts";
import { generateReplyAndEnqueue } from "./dispatch-reply.ts";
import { EXCHANGE_SAFE_FALLBACK } from "./reply-strategy/exchange-reply-guard.ts";
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
          // MessagesRepo.recent (#653 анти-дубль): .where().orderBy().limit()
          orderBy: () => ({ limit: async () => [] }),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        // Применяем только примитивы: SQL-шаблоны (bumpFallbackStreak) пропускаем.
        for (const [k, v] of Object.entries(patch)) {
          if (
            v === null ||
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean"
          ) {
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
      transaction: async <T>(fn: (inner: Db) => Promise<T>) => fn(tx as unknown as Db),
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

  it("auto handoff → полный молчок (без outbound), audit, mode=human, уведомление один раз", async () => {
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
      orderId: 77,
      stageSlug: "payment_proof_waiting",
      customerNoticeSent: false,
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
          // MessagesRepo.recent (#653 анти-дубль): .where().orderBy().limit()
          select: () => ({
            from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
          }),
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

  it("dedup (#653): ответ, совпадающий со свежим сообщением бота, не шлётся", async () => {
    const dupText = "Меняем 2000 USDT.\n\nОформляю заявку?";
    const seeded = { role: "assistant", text: dupText, createdAt: 1000 };
    const inserted: Record<string, unknown>[] = [];
    const outbound: Record<string, unknown>[] = [];
    const tx = {
      execute: async () => undefined,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ mode: "ai", status: "open", escalatedAt: null }],
            // MessagesRepo.recent → свежее сообщение бота с тем же текстом.
            orderBy: () => ({ limit: async () => [seeded] }),
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) }),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          if ("payloadJson" in row) outbound.push(row);
          else if (!("action" in row)) inserted.push(row);
          return { returning: async () => [{ id: inserted.length + outbound.length }] };
        },
      }),
    };
    const db = {
      transaction: async <T>(fn: (inner: Db) => Promise<T>) => fn(tx as unknown as Db),
      execute: async () => undefined,
    } as unknown as Db;
    const out = await generateReplyAndEnqueue({
      db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      clock: { nowEpoch: () => 1000 }, // == seeded.createdAt → в окне дедупа
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "ну ок",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return [
            {
              channelId: "100",
              externalUserId: "u1",
              parts: [{ kind: "text", text: dupText }],
            },
          ];
        },
      },
    });
    expect(out.outboundEnqueued).toBe(0); // дубль не отправлен
    expect(inserted).toHaveLength(0); // и не записан в историю
  });

  it("escalatedReason path → ранний возврат с причиной, LLM не вызывается", async () => {
    let called = false;
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
        userMessageText: "привет",
        mediaOnly: false,
        replyDeferred: true,
        escalatedReason: "kyc_review",
      },
      replyStrategy: {
        async generate() {
          called = true;
          return [];
        },
      },
    });
    expect(out.escalatedReason).toBe("kyc_review");
    expect(out.outboundEnqueued).toBe(0);
    expect(called).toBe(false);
  });

  it("пустые envelopes без auto-takeover → 0 enqueued", async () => {
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
        userMessageText: "привет",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return { envelopes: [], autoTakeover: false };
        },
      },
    });
    expect(out.outboundEnqueued).toBe(0);
  });

  it("fallbackText: заменяет EXCHANGE_SAFE_FALLBACK кастомным текстом", async () => {
    const { db, outbound } = makeAutoHandoffDb();
    const out = await generateReplyAndEnqueue({
      db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      fallbackText: "Уточняю у команды, вернусь!",
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "привет",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return [
            {
              channelId: "100",
              externalUserId: "u1",
              parts: [{ kind: "text" as const, text: EXCHANGE_SAFE_FALLBACK }],
            },
          ];
        },
      },
    });
    expect(out.outboundEnqueued).toBe(1);
    const payloads = outbound.map((r) => JSON.parse(r.payloadJson as string));
    expect(payloads[0].parts[0].text).toBe("Уточняю у команды, вернусь!");
  });

  it("splitReplies: текст с двойным переносом делится на два envelope'а", async () => {
    const { db, outbound } = makeAutoHandoffDb();
    const out = await generateReplyAndEnqueue({
      db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      splitReplies: true,
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "привет",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return [
            {
              channelId: "100",
              externalUserId: "u1",
              parts: [{ kind: "text" as const, text: "Первый абзац.\n\nВторой абзац." }],
            },
          ];
        },
      },
    });
    expect(out.outboundEnqueued).toBe(2);
    expect(outbound).toHaveLength(2);
  });

  it("splitReplies: envelope с медиа не делится, caption попадает в envelopeText как ''", async () => {
    const { db, outbound } = makeAutoHandoffDb();
    const out = await generateReplyAndEnqueue({
      db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      splitReplies: true,
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "привет",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return [
            {
              channelId: "100",
              externalUserId: "u1",
              parts: [
                {
                  kind: "photo" as const,
                  mediaRef: { channelId: "100", externalRef: "r1" },
                  caption: "подпись",
                },
              ],
            },
          ];
        },
      },
    });
    // медиа не делится → 1 envelope
    expect(out.outboundEnqueued).toBe(1);
    expect(outbound).toHaveLength(1);
  });

  it("handoffAfterFallbacks: серия фолбэков >= threshold → applyAutoHandoff fallback_streak", async () => {
    const conversation = {
      mode: "ai",
      status: "open",
      escalatedAt: null as number | null,
      fallbackStreak: 2,
    };
    const outboundRows: Record<string, unknown>[] = [];
    const auditRows: Record<string, unknown>[] = [];
    const tx = {
      execute: async () => undefined,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [conversation],
            orderBy: () => ({ limit: async () => [] }),
          }),
        }),
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(patch)) {
            if (
              v === null ||
              typeof v === "string" ||
              typeof v === "number" ||
              typeof v === "boolean"
            ) {
              (conversation as Record<string, unknown>)[k] = v;
            }
          }
          return { where: () => ({ returning: async () => [conversation] }) };
        },
      }),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          if ("action" in row) auditRows.push(row);
          else if ("payloadJson" in row) outboundRows.push(row);
          return {
            returning: async () => [{ id: auditRows.length + outboundRows.length, ...row }],
          };
        },
      }),
    };
    const db = {
      transaction: async <T>(fn: (inner: Db) => Promise<T>) => fn(tx as unknown as Db),
      execute: async () => undefined,
    } as unknown as Db;

    const out = await generateReplyAndEnqueue({
      db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      handoffAfterFallbacks: 2,
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "привет",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return [
            {
              channelId: "100",
              externalUserId: "u1",
              parts: [{ kind: "text" as const, text: EXCHANGE_SAFE_FALLBACK }],
            },
          ];
        },
      },
    });
    expect(out.escalatedReason).toBe("fallback_streak");
  });

  it("fallback_streak + notifications → notify вызван, ошибка notify глотается", async () => {
    const conversation = {
      mode: "ai",
      status: "open",
      escalatedAt: null as number | null,
      fallbackStreak: 3,
    };
    const tx = {
      execute: async () => undefined,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [conversation],
            orderBy: () => ({ limit: async () => [] }),
          }),
        }),
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [conversation] }) }),
      }),
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          returning: async () => [{ id: 1, ...row }],
        }),
      }),
    };
    const db = {
      transaction: async <T>(fn: (inner: Db) => Promise<T>) => fn(tx as unknown as Db),
      execute: async () => undefined,
    } as unknown as Db;

    const notifyCalls: unknown[] = [];
    const notifications = {
      notify: async (ev: unknown) => {
        notifyCalls.push(ev);
        throw new Error("smtp down");
      },
    };

    const out = await generateReplyAndEnqueue({
      db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      handoffAfterFallbacks: 1,
      notifications: notifications as never,
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "привет",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return [
            {
              channelId: "100",
              externalUserId: "u1",
              parts: [{ kind: "text" as const, text: EXCHANGE_SAFE_FALLBACK }],
            },
          ];
        },
      },
    });
    expect(out.escalatedReason).toBe("fallback_streak");
    expect(notifyCalls).toHaveLength(1);
  });

  it("splitReplies: текст без двойного переноса → один envelope не разбивается (lines 105-106)", async () => {
    const { db, outbound } = makeAutoHandoffDb();
    const out = await generateReplyAndEnqueue({
      db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      splitReplies: true,
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "привет",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return [
            {
              channelId: "100",
              externalUserId: "u1",
              parts: [{ kind: "text" as const, text: "Один абзац без переноса." }],
            },
          ];
        },
      },
    });
    // текст без \n\n → не делится → 1 envelope
    expect(out.outboundEnqueued).toBe(1);
    expect(outbound).toHaveLength(1);
  });

  it("replaceFallbackText: envelope с нефолбэком-частью → ': p' ternary-ветка (line 132)", async () => {
    const { db, outbound } = makeAutoHandoffDb();
    await generateReplyAndEnqueue({
      db,
      tenant,
      channel,
      channelDbId: 100,
      inbound: fakeInbound(),
      fallbackText: "Кастом",
      result: {
        contactId: 1,
        conversationId: 10,
        persisted: true,
        outboundEnqueued: 0,
        userMessageText: "привет",
        mediaOnly: false,
        replyDeferred: true,
      },
      replyStrategy: {
        async generate() {
          return [
            {
              channelId: "100",
              externalUserId: "u1",
              // первая часть — фолбэк (заменится), вторая — обычный текст (останется как есть → line 132)
              parts: [
                { kind: "text" as const, text: EXCHANGE_SAFE_FALLBACK },
                { kind: "text" as const, text: "Дополнительная инструкция." },
              ],
            },
          ];
        },
      },
    });
    expect(outbound).toHaveLength(1);
    const payload = JSON.parse((outbound[0] as Record<string, unknown>).payloadJson as string);
    expect(payload.parts[0].text).toBe("Кастом");
    expect(payload.parts[1].text).toBe("Дополнительная инструкция.");
  });
});
