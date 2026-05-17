import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import type { TgUpdate } from "@/telegram/types.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "test-secret";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

interface OutgoingCall {
  method: string;
  body: Record<string, unknown>;
}

function setup() {
  const sent: OutgoingCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const apiMethod = url.split("/").pop() ?? "";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    sent.push({ method: apiMethod, body });
    const result =
      apiMethod === "sendMessage"
        ? {
            message_id: Math.floor(Math.random() * 1_000_000),
            chat: { id: body.chat_id, type: "private" },
            date: Math.floor(Date.now() / 1000),
            text: body.text,
          }
        : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const telegram = new TelegramClient({
    token: "test-token",
    fetch: fetchImpl,
  });
  const router = createRouter({
    sql,
    telegram,
    webhookSecret: SECRET,
  });
  const server = Bun.serve({
    port: 0,
    fetch: (req) => router.handle(req),
  });
  return { router, server, sent };
}

function teardown(s: { server: Server }) {
  s.server.stop(true);
}

function update(fromId: number, text: string, chatId = fromId): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: Math.floor(Math.random() * 1_000_000),
      from: { id: fromId, is_bot: false, first_name: "T" },
      chat: { id: chatId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

let ctx: ReturnType<typeof setup>;

beforeEach(() => {
  delete process.env.TELEGRAM_OPEN_ACCESS;
  ctx = setup();
});

afterEach(() => {
  teardown(ctx);
});

describe("/telegram/<secret> webhook", () => {
  test("rejects wrong path secret with 403", async () => {
    const url = `http://127.0.0.1:${ctx.server.port}/telegram/wrong-secret`;
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(1, "hi")),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(ctx.sent).toHaveLength(0);
  });

  test("rejects when X-Telegram-Bot-Api-Secret-Token header mismatches", async () => {
    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(1, "hi")),
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "nope",
      },
    });
    expect(res.status).toBe(403);
  });

  test("ignores updates from non-whitelisted users (no DB writes, no outgoing calls)", async () => {
    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(999, "hi")),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(ctx.sent).toHaveLength(0);

    const usersRepo = new UsersRepo(sql);
    expect(await usersRepo.byTgId(999)).toBeNull();
  });

  test("TELEGRAM_OPEN_ACCESS=1: registers unknown tg user on first message", async () => {
    const prev = process.env.TELEGRAM_OPEN_ACCESS;
    process.env.TELEGRAM_OPEN_ACCESS = "1";
    try {
      teardown(ctx);
      ctx = setup();
      const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
      const res = await fetch(url, {
        method: "POST",
        body: JSON.stringify(update(888, "привет")),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await new UsersRepo(sql).byTgId(888)).not.toBeNull();
      // No RAG configured — no placeholder stub is sent to Telegram.
      expect(ctx.sent).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_OPEN_ACCESS;
      else process.env.TELEGRAM_OPEN_ACCESS = prev;
    }
  });

  test("whitelisted user without RAG: persists user message only, no sendMessage", async () => {
    const usersRepo = new UsersRepo(sql);
    const convsRepo = new ConversationsRepo(sql);
    const msgsRepo = new MessagesRepo(sql);
    const u = await usersRepo.create({ tgUserId: 555, tgUsername: "bob" });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(555, "hello world")),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);

    expect(ctx.sent).toHaveLength(0);

    const conv = await convsRepo.byUserId(u.id);
    expect(conv).not.toBeNull();
    const msgs = await msgsRepo.listByConversation(conv!.id);
    expect(msgs.map((m) => m.role)).toEqual(["user"]);
    expect(msgs[0]!.text).toBe("hello world");
  });

  test("mode=human: persists user message but does NOT call sendMessage", async () => {
    const usersRepo = new UsersRepo(sql);
    const convsRepo = new ConversationsRepo(sql);
    const msgsRepo = new MessagesRepo(sql);
    const u = await usersRepo.create({ tgUserId: 777 });
    const c = await convsRepo.ensureForUser(u.id);
    await convsRepo.setMode(c.id, "human", 1);

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(777, "I need help")),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(ctx.sent).toHaveLength(0);

    const msgs = await msgsRepo.listByConversation(c.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
  });
});
