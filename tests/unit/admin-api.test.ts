import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import { TelegramClient, type FetchLike } from "@/telegram/client.ts";

const SECRET = "s";

function setup() {
  const db = openDb({ path: ":memory:" });
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({ db, telegram, webhookSecret: SECRET });
  const server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  return { db, server };
}

function teardown(s: { db: ReturnType<typeof openDb>; server: Server }) {
  s.server.stop(true);
  s.db.close();
}

let ctx: ReturnType<typeof setup>;
let cookie: string;

beforeEach(async () => {
  ctx = setup();
  const admins = new AdminsRepo(ctx.db);
  await admins.create({ email: "op@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${ctx.server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  const set = login.headers.get("set-cookie")!;
  cookie = set.split(";")[0]!;
});
afterEach(() => teardown(ctx));

function url(path: string) {
  return `http://127.0.0.1:${ctx.server.port}${path}`;
}
function authed(extra: RequestInit = {}): RequestInit {
  return {
    ...extra,
    headers: { ...(extra.headers ?? {}), cookie },
  };
}

describe("GET /admin/api/users", () => {
  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/users"));
    expect(res.status).toBe(401);
  });

  test("returns whitelist with status and counts", async () => {
    const users = new UsersRepo(ctx.db);
    users.create({ tgUserId: 11, tgUsername: "a", status: "qualified" });
    users.create({ tgUserId: 22, tgUsername: "b", status: "new" });

    const res = await fetch(url("/admin/api/users"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ tg_user_id: number; status: string }> };
    expect(body.users).toHaveLength(2);
    const ids = body.users.map((u) => u.tg_user_id).sort();
    expect(ids).toEqual([11, 22]);
  });
});

describe("GET /admin/api/conversations", () => {
  test("queued conversations come first, then by recency", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const messages = new MessagesRepo(ctx.db);

    const u1 = users.create({ tgUserId: 1 });
    const u2 = users.create({ tgUserId: 2 });
    const u3 = users.create({ tgUserId: 3 });

    const c1 = conversations.ensureForUser(u1.id);
    const c2 = conversations.ensureForUser(u2.id);
    const c3 = conversations.ensureForUser(u3.id);

    messages.add({ conversationId: c1.id, role: "user", text: "old" });
    conversations.touch(c1.id);
    messages.add({ conversationId: c2.id, role: "user", text: "newer" });
    conversations.touch(c2.id);
    conversations.setMode(c3.id, "queued");
    messages.add({ conversationId: c3.id, role: "user", text: "queued one" });
    conversations.touch(c3.id);

    const res = await fetch(url("/admin/api/conversations"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ id: number; mode: string; user: { tg_user_id: number } }>;
    };
    expect(body.conversations[0]!.mode).toBe("queued");
    expect(body.conversations[0]!.user.tg_user_id).toBe(3);
  });
});

describe("GET /admin/api/conversations/:id", () => {
  test("returns conversation, user, and messages", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const messages = new MessagesRepo(ctx.db);
    const u = users.create({ tgUserId: 99 });
    const c = conversations.ensureForUser(u.id);
    messages.add({ conversationId: c.id, role: "user", text: "hi" });
    messages.add({ conversationId: c.id, role: "assistant", text: "hello" });

    const res = await fetch(url(`/admin/api/conversations/${c.id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { id: number };
      user: { tg_user_id: number };
      messages: Array<{ role: string; text: string }>;
    };
    expect(body.conversation.id).toBe(c.id);
    expect(body.user.tg_user_id).toBe(99);
    expect(body.messages).toHaveLength(2);
    expect(body.messages.map((m) => m.text)).toEqual(["hi", "hello"]);
  });

  test("returns 404 for missing conversation", async () => {
    const res = await fetch(url("/admin/api/conversations/999999"), authed());
    expect(res.status).toBe(404);
  });

  test("includes empty memory object when no facts stored", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: 510 });
    const c = conversations.ensureForUser(u.id);

    const res = await fetch(url(`/admin/api/conversations/${c.id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { facts: Record<string, string> } };
    expect(body.memory).toBeDefined();
    expect(body.memory.facts).toEqual({});
  });

  test("includes stored memory facts", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: 511 });
    const c = conversations.ensureForUser(u.id);
    users.mergeMemoryFacts(u.id, { city: "Москва", age: "25" });

    const res = await fetch(url(`/admin/api/conversations/${c.id}`), authed());
    const body = (await res.json()) as {
      memory: { facts: Record<string, string>; updatedAt?: number };
    };
    expect(body.memory.facts).toEqual({ city: "Москва", age: "25" });
    expect(body.memory.updatedAt).toBeGreaterThan(0);
  });
});

describe("PATCH /admin/api/users/:id/memory", () => {
  test("requires auth", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 600 });
    const res = await fetch(url(`/admin/api/users/${u.id}/memory`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ facts: { city: "x" } }),
    });
    expect(res.status).toBe(401);
  });

  test("replaces facts wholesale (operator edit is authoritative)", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 601 });
    users.mergeMemoryFacts(u.id, { city: "Москва", age: "25", intent: "Дубай" });

    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: { city: "Сочи", language: "ru" } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { facts: Record<string, string> } };
    // age and intent are GONE — operator edit replaces, not merges.
    expect(body.memory.facts).toEqual({ city: "Сочи", language: "ru" });

    // Persists across re-reads.
    const reread = users.getMemory(u.id);
    expect(reread.facts).toEqual({ city: "Сочи", language: "ru" });
  });

  test("trims whitespace and drops empty values", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 602 });

    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          facts: { city: "  Москва  ", empty: "  ", age: "26" },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { facts: Record<string, string> } };
    expect(body.memory.facts).toEqual({ city: "Москва", age: "26" });
  });

  test("rejects 400 when facts is not an object", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 603 });
    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: ["not", "an", "object"] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 404 for missing user", async () => {
    const res = await fetch(
      url("/admin/api/users/999999/memory"),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: {} }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("clears memory when facts is empty object", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 604 });
    users.mergeMemoryFacts(u.id, { city: "x" });

    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: {} }),
      }),
    );
    expect(res.status).toBe(200);
    expect(users.getMemory(u.id).facts).toEqual({});
  });

  test("caps oversized values to keep memory factual not essay-length", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 605 });
    const huge = "x".repeat(500);
    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: { ok: "fine", huge } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { facts: Record<string, string> } };
    expect(body.memory.facts.ok).toBe("fine");
    expect(body.memory.facts.huge).toBeUndefined();
  });
});

describe("POST /admin/api/conversations/:id/take and /release", () => {
  test("take switches mode to human and records assigned admin", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: 55 });
    const c = conversations.ensureForUser(u.id);

    const take = await fetch(
      url(`/admin/api/conversations/${c.id}/take`),
      authed({ method: "POST" }),
    );
    expect(take.status).toBe(200);
    const after = conversations.byId(c.id)!;
    expect(after.mode).toBe("human");
    expect(after.assigned_admin_id).not.toBeNull();
  });

  test("release switches mode back to ai and clears assignment", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: 56 });
    const c = conversations.ensureForUser(u.id);
    conversations.setMode(c.id, "human", 1);

    const rel = await fetch(
      url(`/admin/api/conversations/${c.id}/release`),
      authed({ method: "POST" }),
    );
    expect(rel.status).toBe(200);
    const after = conversations.byId(c.id)!;
    expect(after.mode).toBe("ai");
    expect(after.assigned_admin_id).toBeNull();
  });
});
