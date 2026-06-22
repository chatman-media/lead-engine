// Unit (без PG) для ensureOperatorTopic. withTenant(db)=db.transaction(cb);
// общий queue-tx отдаёт результаты последовательных запросов через единый
// узел (chainable + thenable). Покрывает payoutPointId-пул, least-busy и
// гонку записи треда.

import { describe, expect, it } from "bun:test";
import type { TelegramClient } from "@chatman-media/channel-telegram";
import type { Db } from "./dal/types.ts";
import { ensureOperatorTopic } from "./operator-forum-topic.ts";

function queueDb(queue: unknown[]) {
  const q = [...queue];
  const next = () => q.shift();
  const node: Record<string, unknown> = {
    execute: async () => undefined,
    select: () => node,
    from: () => node,
    innerJoin: () => node,
    where: () => node,
    groupBy: () => node,
    update: () => node,
    set: () => node,
    limit: async () => next(),
    returning: async () => next(),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(next()).then(res, rej),
  };
  return { transaction: async (cb: (tx: unknown) => unknown) => cb(node) } as unknown as Db;
}

const client = (threadId: number) =>
  ({
    createForumTopic: async () => ({ message_thread_id: threadId, name: "t" }),
  }) as unknown as TelegramClient;

describe("ensureOperatorTopic", () => {
  it("диалога нет → null", async () => {
    const db = queueDb([[]]); // existing select → нет строк
    const out = await ensureOperatorTopic({
      db,
      client: client(1),
      tenantId: 1,
      chatId: "-100",
      context: { conversationId: 5 },
      nowEpoch: 0,
    });
    expect(out).toBeNull();
  });

  it("тред уже есть → переиспользуем (created=false)", async () => {
    const db = queueDb([[{ operatorThreadId: 42 }]]);
    const out = await ensureOperatorTopic({
      db,
      client: client(1),
      tenantId: 1,
      chatId: "-100",
      context: { conversationId: 5 },
      nowEpoch: 0,
    });
    expect(out).toEqual({ threadId: 42, created: false });
  });

  it("создаёт тред с payoutPointId-пулом + least-busy (lines 94-105), новый тред", async () => {
    const db = queueDb([
      [{ operatorThreadId: null }], // 1. existing — нет треда
      [{ adminId: 1 }], // 2. eligibleAdminIds (payoutPointId set)
      [{ adminId: 1, name: "Иван", email: "i@x.io" }], // 3. candidates
      [{ adminId: 1, open: 0 }], // 4. loadRows
      [{ operatorThreadId: 7 }], // 5. persisted update.returning (rows>0)
    ]);
    const out = await ensureOperatorTopic({
      db,
      client: client(7),
      tenantId: 1,
      chatId: "-100",
      context: { conversationId: 5, displayName: "Боб", amountLabel: "500 USDT", payoutPointId: 9 },
      nowEpoch: 100,
    });
    expect(out).toEqual({ threadId: 7, created: true });
  });

  it("гонка: update вернул 0 строк → перечитываем чужой тред (lines 140-146)", async () => {
    const db = queueDb([
      [{ operatorThreadId: null }], // 1. existing
      // нет payoutPointId → пропуск eligibleAdminIds
      [{ adminId: 2, name: "А", email: "a@x.io" }], // 2. candidates
      [], // 3. loadRows (пусто)
      [], // 4. update.returning → 0 строк (кто-то записал раньше)
      [{ operatorThreadId: 99 }], // 5. re-select → чужой тред
    ]);
    const out = await ensureOperatorTopic({
      db,
      client: client(7), // наш топик осиротеет
      tenantId: 1,
      chatId: "-100",
      context: { conversationId: 5 },
      nowEpoch: 100,
    });
    // persisted = 99 (чужой), created = 99 === 7 → false
    expect(out).toEqual({ threadId: 99, created: false });
  });
});
