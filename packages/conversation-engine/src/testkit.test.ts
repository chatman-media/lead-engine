// Contract-тесты in-memory фейков из testkit.ts: ветки, которые pipeline-тесты
// не трогают (touch/markAsRead/setAssignee/idempotency/edge-ветки merge).

import { describe, expect, it } from "bun:test";
import {
  FakeContactsRepo,
  FakeConversationsRepo,
  FakeMessagesRepo,
  FakeOutboundQueueRepo,
} from "./testkit.ts";

describe("FakeConversationsRepo", () => {
  it("updateInboxMetadata / touchLastMessageAt / markAsRead / setAssignee", async () => {
    const repo = new FakeConversationsRepo(1);
    const convo = await repo.create({
      contactId: 1,
      source: "bot",
      nowEpoch: 100,
    });

    await repo.updateInboxMetadata(convo.id, {
      lastMessageText: "hi",
      lastMessageAt: 150,
      incrementUnread: true,
      status: "resolved",
    });
    expect(repo.all()[0]).toMatchObject({
      lastMessageText: "hi",
      lastMessageAt: 150,
      unreadCount: 1,
      status: "resolved",
    });
    // Несуществующий id — no-op без ошибок.
    await repo.updateInboxMetadata(999, { lastMessageText: "missing" });

    await repo.touchLastMessageAt(convo.id, 200);
    expect(repo.all()[0]?.lastMessageAt).toBe(200);
    await repo.touchLastMessageAt(999, 300);

    await repo.markAsRead(convo.id);
    expect(repo.all()[0]?.unreadCount).toBe(0);
    await repo.markAsRead(999);

    await repo.setAssignee(convo.id, 7);
    expect(repo.all()[0]?.assignedAdminId).toBe(7);
    await repo.setAssignee(convo.id, null);
    expect(repo.all()[0]?.assignedAdminId).toBeNull();
    await repo.setAssignee(999, 1);

    expect(await repo.findByContactAndChannel(1, 555)).toBeNull();
  });
});

describe("FakeContactsRepo", () => {
  it("byId/mergeAttributes edge-ветки", async () => {
    const repo = new FakeContactsRepo(1);
    expect(await repo.byId(1)).toBeNull();

    const contact = await repo.create({});
    expect(await repo.mergeAttributes(999, { a: 1 }, 10)).toBeNull();
    // Пустой partial — short-circuit без записи.
    expect((await repo.mergeAttributes(contact.id, {}, 10))?.id).toBe(contact.id);
    const merged = await repo.mergeAttributes(contact.id, { a: 1 }, 11);
    expect(JSON.parse(merged?.attributesJson ?? "{}")).toEqual({ a: 1 });
  });
});

describe("FakeMessagesRepo", () => {
  it("findUserByExternalId: нечисловой external id → null", async () => {
    const repo = new FakeMessagesRepo(1);
    expect(await repo.findUserByExternalId(1, "abc")).toBeNull();
  });
});

describe("FakeOutboundQueueRepo", () => {
  it("enqueue дедупит по idempotencyKey", async () => {
    const repo = new FakeOutboundQueueRepo(1);
    const first = await repo.enqueue({
      channelId: 1,
      envelope: { idempotencyKey: "k1" },
      nowEpoch: 1,
    });
    const dup = await repo.enqueue({
      channelId: 1,
      envelope: { idempotencyKey: "k1" },
      nowEpoch: 2,
    });
    expect(dup.id).toBe(first.id);
    expect(repo.all()).toHaveLength(1);
  });
});

describe("FakeMessagesRepo.insert / setTranslation / getTranslation", () => {
  it("insert возвращает строку сообщения", async () => {
    const repo = new FakeMessagesRepo(1);
    const msg = await repo.insert({
      conversationId: 10,
      role: "user",
      text: "hello",
      nowEpoch: 100,
    });
    expect(msg.id).toBe(1);
    expect(msg.text).toBe("hello");
  });

  it("setTranslation: несуществующий id → no-op", async () => {
    const repo = new FakeMessagesRepo(1);
    await expect(repo.setTranslation(999, { text: "x", lang: "en" })).resolves.toBeUndefined();
  });

  it("setTranslation+getTranslation: round-trip", async () => {
    const repo = new FakeMessagesRepo(1);
    const msg = await repo.insert({
      conversationId: 10,
      role: "user",
      text: "привет",
      nowEpoch: 1,
    });
    await repo.setTranslation(msg.id, { text: "hello", lang: "en" });
    const tr = await repo.getTranslation(msg.id);
    expect(tr).toEqual({ text: "hello", lang: "en" });
  });

  it("getTranslation: несуществующий id → null", async () => {
    const repo = new FakeMessagesRepo(1);
    expect(await repo.getTranslation(999)).toBeNull();
  });

  it("getTranslation: сообщение без перевода → null", async () => {
    const repo = new FakeMessagesRepo(1);
    const msg = await repo.insert({ conversationId: 10, role: "user", text: "hi", nowEpoch: 1 });
    expect(await repo.getTranslation(msg.id)).toBeNull();
  });
});
