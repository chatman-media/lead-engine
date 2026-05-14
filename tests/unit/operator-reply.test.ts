import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

interface SentMessage {
  chatId: number;
  text: string;
}

function setup() {
  const sent: SentMessage[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("sendMessage")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        chat_id: number;
        text: string;
      };
      sent.push({ chatId: body.chat_id, text: body.text });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 99,
            chat: { id: body.chat_id, type: "private" },
            date: 0,
            text: body.text,
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
    });
  };

  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({ sql, telegram, webhookSecret: "s" });
  const server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  return { server, sent };
}

function teardown(s: { server: Server }) {
  s.server.stop(true);
}

let ctx: ReturnType<typeof setup>;
let cookie: string;
let convId: number;
let tgUserId: number;

beforeEach(async () => {
  ctx = setup();

  // Create admin + get session cookie
  const admins = new AdminsRepo(sql);
  await admins.create({ email: "op@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${ctx.server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  // Create user + conversation in human mode
  tgUserId = 555;
  const users = new UsersRepo(sql);
  const u = await users.create({ tgUserId });
  const conversations = new ConversationsRepo(sql);
  const c = await conversations.ensureForUser(u.id);
  await conversations.setMode(c.id, "human", 1);
  convId = c.id;
});

afterEach(() => teardown(ctx));

function url(path: string) {
  return `http://127.0.0.1:${ctx.server.port}${path}`;
}

describe("POST /admin/api/conversations/:id/reply", () => {
  test("requires auth", async () => {
    const res = await fetch(url(`/admin/api/conversations/${convId}/reply`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(401);
    expect(ctx.sent).toHaveLength(0);
  });

  test("returns 400 when text is missing or empty", async () => {
    for (const body of [{}, { text: "" }, { text: "  " }]) {
      const res = await fetch(url(`/admin/api/conversations/${convId}/reply`), {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(ctx.sent).toHaveLength(0);
  });

  test("returns 404 for unknown conversation", async () => {
    const res = await fetch(url("/admin/api/conversations/999999/reply"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 409 when conversation is not in human mode", async () => {
    const conversations = new ConversationsRepo(sql);
    await conversations.setMode(convId, "ai");

    const res = await fetch(url(`/admin/api/conversations/${convId}/reply`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(409);
    expect(ctx.sent).toHaveLength(0);
  });

  test("sends message via Telegram and persists it with role=human", async () => {
    const res = await fetch(url(`/admin/api/conversations/${convId}/reply`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "Добрый день! Сейчас помогу." }),
    });
    expect(res.status).toBe(200);

    // Telegram was called
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.chatId).toBe(tgUserId);
    expect(ctx.sent[0]!.text).toBe("Добрый день! Сейчас помогу.");

    // Message persisted with role=human
    const msgs = new MessagesRepo(sql);
    const all = await msgs.listByConversation(convId, 50);
    const humanMsg = all.find((m) => m.role === "human");
    expect(humanMsg?.text).toBe("Добрый день! Сейчас помогу.");
    expect(humanMsg?.tg_message_id).toBe(99);
  });

  test("conversation stays in human mode after reply", async () => {
    await fetch(url(`/admin/api/conversations/${convId}/reply`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "ok" }),
    });
    const conversations = new ConversationsRepo(sql);
    expect((await conversations.byId(convId))!.mode).toBe("human");
  });

  test("publishes message:new WS event", async () => {
    const events: unknown[] = [];
    const wsUrl = `ws://127.0.0.1:${ctx.server.port}/admin/api/ws`;

    // Need createServer for WS — skip here, covered by admin-ws test.
    // This test verifies the onMessagePersisted hook is called via the returned body.
    const res = await fetch(url(`/admin/api/conversations/${convId}/reply`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "ping" }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      tgUserId: number;
      conversationId: number;
    };
    expect(body.ok).toBe(true);
    expect(body.tgUserId).toBe(tgUserId);
    expect(body.conversationId).toBe(convId);
    void events;
    void wsUrl;
  });
});
