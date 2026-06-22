// Unit (без PG) для OperatorActionHandler. client/db фейкаются; queue-tx для
// applyConversationModeAction (select mode → update + audit).

import { describe, expect, it } from "bun:test";
import type { TelegramClient, TgCallbackQuery } from "@chatman-media/channel-telegram";
import type { Db } from "./dal/types.ts";
import { OperatorActionHandler } from "./operator-conversation-actions.ts";

function fakeClient() {
  const answers: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    answerCallbackQuery: async (a: Record<string, unknown>) => {
      answers.push(a);
    },
    sendMessage: async (m: Record<string, unknown>) => {
      sent.push(m);
    },
  } as unknown as TelegramClient;
  return { client, answers, sent };
}

function fakeDb(modeRow: unknown[]) {
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const node: Record<string, unknown> = {
    execute: async () => undefined,
    select: () => node,
    from: () => node,
    where: () => node,
    limit: async () => modeRow,
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
  const db = {
    transaction: async (cb: (t: unknown) => unknown) => cb(node),
  } as unknown as Db;
  return { db, updates, inserts };
}

const cq = (chatId = 5): TgCallbackQuery =>
  ({ id: "cb", from: { id: 1 }, message: { chat: { id: chatId } } }) as unknown as TgCallbackQuery;

const settings = { adminId: 7, tenantId: 1 };

describe("handleOperatorAction", () => {
  it("чужой tenant → отказ", async () => {
    const { client, answers } = fakeClient();
    const h = new OperatorActionHandler(() => client, {});
    await h.handleOperatorAction(cq(), settings, {
      action: "takeover",
      conversationId: 9,
      tenantId: 2,
    });
    expect(answers[0]?.text).toContain("Нет доступа");
  });

  it("open_chat с appUrl → url-ответ", async () => {
    const { client, answers } = fakeClient();
    const h = new OperatorActionHandler(() => client, { appUrl: "https://app.test/" });
    await h.handleOperatorAction(cq(), settings, {
      action: "open_chat",
      conversationId: 9,
      tenantId: 1,
    });
    expect(answers[0]?.url).toBe("https://app.test/conversations/9");
  });

  it("open_chat без appUrl → текстовый ответ", async () => {
    const { client, answers } = fakeClient();
    const h = new OperatorActionHandler(() => client, {});
    await h.handleOperatorAction(cq(), settings, {
      action: "open_chat",
      conversationId: 9,
      tenantId: 1,
    });
    expect(String(answers[0]?.text)).toContain("#9");
  });

  it("takeover без db → 'не настроены'", async () => {
    const { client, answers } = fakeClient();
    const h = new OperatorActionHandler(() => client, {});
    await h.handleOperatorAction(cq(), settings, {
      action: "takeover",
      conversationId: 9,
      tenantId: 1,
    });
    expect(String(answers[0]?.text)).toContain("не настроены");
  });

  it("takeover c db → меняет режим + шлёт сообщение с кнопкой", async () => {
    const { client, answers, sent } = fakeClient();
    const { db, updates, inserts } = fakeDb([{ mode: "ai" }]);
    const h = new OperatorActionHandler(() => client, { db, appUrl: "https://app.test" });
    await h.handleOperatorAction(cq(), settings, {
      action: "takeover",
      conversationId: 9,
      tenantId: 1,
    });
    expect(updates[0]?.mode).toBe("human");
    expect(inserts[0]?.action).toContain("takeover");
    expect(answers[0]?.text).toBe("Взято в работу");
    expect(String(sent[0]?.text)).toContain("Взято в работу");
  });
});

describe("applyConversationModeAction", () => {
  const h = (db?: Db) => new OperatorActionHandler(() => null, db ? { db } : {});

  it("без db → error", async () => {
    const r = await h().applyConversationModeAction({
      tenantId: 1,
      adminId: 7,
      conversationId: 9,
      action: "takeover",
    });
    expect(r.kind).toBe("error");
  });

  it("диалог не найден → not_found", async () => {
    const { db } = fakeDb([]);
    const r = await h(db).applyConversationModeAction({
      tenantId: 1,
      adminId: 7,
      conversationId: 9,
      action: "takeover",
    });
    expect(r.kind).toBe("not_found");
  });

  it("режим уже целевой → noop", async () => {
    const { db } = fakeDb([{ mode: "human" }]);
    const r = await h(db).applyConversationModeAction({
      tenantId: 1,
      adminId: 7,
      conversationId: 9,
      action: "takeover",
    });
    expect(r.kind).toBe("noop");
  });

  it("return_to_ai из human → changed (ai)", async () => {
    const { db, updates } = fakeDb([{ mode: "human" }]);
    const r = await h(db).applyConversationModeAction({
      tenantId: 1,
      adminId: 7,
      conversationId: 9,
      action: "return_ai",
    });
    expect(r.kind).toBe("changed");
    expect(updates[0]?.mode).toBe("ai");
    expect(String(r.messageHtml)).toContain("AI снова активен");
  });
});
