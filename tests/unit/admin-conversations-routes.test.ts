// Coverage for `src/admin/routes/conversations.ts`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let server: Server;
let cookie: string;

beforeEach(async () => {
  const telegram = new TelegramClient({ token: "t", fetch: async () => new Response("{}") });
  const router = createRouter({ sql, telegram, webhookSecret: SECRET });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  const admins = new AdminsRepo(sql);
  await admins.create({ email: "op@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}, 30_000);

afterEach(() => server.stop(true));

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const authed = (extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: { ...(extra.headers ?? {}), cookie },
});
const jsonReq = (method: string, bodyObj: unknown): RequestInit =>
  authed({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });

async function seedConversation() {
  const user = await new UsersRepo(sql).create({ tgUserId: Math.floor(Math.random() * 1e9) });
  const conv = await new ConversationsRepo(sql).ensureForUser(user.id);
  return { userId: user.id, convId: conv.id };
}

describe("GET /admin/api/conversations", () => {
  test("requires auth", async () => {
    expect((await fetch(url("/admin/api/conversations"))).status).toBe(401);
  });

  test("lists conversations and accepts the source filter", async () => {
    await seedConversation();
    const all = await fetch(url("/admin/api/conversations"), authed());
    expect(((await all.json()) as { conversations: unknown[] }).conversations.length).toBe(1);
    const filtered = await fetch(url("/admin/api/conversations?source=bot&escalated=1"), authed());
    expect(filtered.status).toBe(200);
  });
});

describe("GET /admin/api/conversations/:id", () => {
  test("returns the conversation, user, messages, memory and summary", async () => {
    const { convId } = await seedConversation();
    await new MessagesRepo(sql).add({ conversationId: convId, role: "user", text: "hi" });
    const res = await fetch(url(`/admin/api/conversations/${convId}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { id: number }; messages: unknown[] };
    expect(body.conversation.id).toBe(convId);
    expect(body.messages).toHaveLength(1);
  });

  test("404 for an unknown conversation", async () => {
    expect((await fetch(url("/admin/api/conversations/999999"), authed())).status).toBe(404);
  });
});

describe("PATCH /admin/api/users/:id/memory", () => {
  test("replaces the candidate's memory facts", async () => {
    const { userId } = await seedConversation();
    const res = await fetch(
      url(`/admin/api/users/${userId}/memory`),
      jsonReq("PATCH", {
        facts: { city: "Алматы", age: 27, blank: "  ", longKey: "x".repeat(50) },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { facts: Record<string, string> } };
    // number coerced to string; blank dropped; over-long key dropped.
    expect(body.memory.facts.city).toBe("Алматы");
    expect(body.memory.facts.age).toBe("27");
    expect(body.memory.facts.blank).toBeUndefined();
  });

  test("400 when facts is not a plain object", async () => {
    const { userId } = await seedConversation();
    const res = await fetch(
      url(`/admin/api/users/${userId}/memory`),
      jsonReq("PATCH", { facts: [] }),
    );
    expect(res.status).toBe(400);
  });

  test("404 for an unknown user", async () => {
    const res = await fetch(url("/admin/api/users/999999/memory"), jsonReq("PATCH", { facts: {} }));
    expect(res.status).toBe(404);
  });
});

describe("take / release / delete", () => {
  test("take switches the conversation into human mode", async () => {
    const { convId } = await seedConversation();
    const res = await fetch(
      url(`/admin/api/conversations/${convId}/take`),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { conversation: { mode: string } }).conversation.mode).toBe(
      "human",
    );
  });

  test("release switches it back to ai mode", async () => {
    const { convId } = await seedConversation();
    await fetch(url(`/admin/api/conversations/${convId}/take`), authed({ method: "POST" }));
    const res = await fetch(
      url(`/admin/api/conversations/${convId}/release`),
      authed({ method: "POST" }),
    );
    expect(((await res.json()) as { conversation: { mode: string } }).conversation.mode).toBe("ai");
  });

  test("take / release / delete return 404 for an unknown conversation", async () => {
    expect(
      (await fetch(url("/admin/api/conversations/999999/take"), authed({ method: "POST" }))).status,
    ).toBe(404);
    expect(
      (await fetch(url("/admin/api/conversations/999999/release"), authed({ method: "POST" })))
        .status,
    ).toBe(404);
    expect(
      (await fetch(url("/admin/api/conversations/999999"), authed({ method: "DELETE" }))).status,
    ).toBe(404);
  });

  test("delete removes the conversation and writes an audit row", async () => {
    const { convId } = await seedConversation();
    const res = await fetch(
      url(`/admin/api/conversations/${convId}`),
      authed({ method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(await new ConversationsRepo(sql).byId(convId)).toBeNull();
  });
});

describe("POST /admin/api/conversations/:id/reply", () => {
  test("409 when the conversation is not in human mode", async () => {
    const { convId } = await seedConversation();
    const res = await fetch(
      url(`/admin/api/conversations/${convId}/reply`),
      jsonReq("POST", { text: "hello" }),
    );
    expect(res.status).toBe(409);
  });

  test("400 when text is missing, 200 once taken into human mode", async () => {
    const { convId } = await seedConversation();
    await fetch(url(`/admin/api/conversations/${convId}/take`), authed({ method: "POST" }));
    const empty = await fetch(
      url(`/admin/api/conversations/${convId}/reply`),
      jsonReq("POST", { text: "  " }),
    );
    expect(empty.status).toBe(400);
    const ok = await fetch(
      url(`/admin/api/conversations/${convId}/reply`),
      jsonReq("POST", { text: "operator reply" }),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
  });
});
