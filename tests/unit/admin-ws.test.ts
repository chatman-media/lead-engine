import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { AdminsRepo } from "@/db/repos/admins.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import { createServer } from "@/server.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";

function makeServer() {
  const db = openDb({ path: ":memory:" });
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const server = createServer({
    db,
    telegram,
    webhookSecret: "s",
    port: 0,
  });
  return { db, server };
}

let ctx: { db: ReturnType<typeof openDb>; server: Server };
let cookie: string;

beforeEach(async () => {
  ctx = makeServer();
  const admins = new AdminsRepo(ctx.db);
  await admins.create({ email: "ws@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${ctx.server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ws@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
});

afterEach(() => {
  ctx.server.stop(true);
  ctx.db.close();
});

function connect(headers: Record<string, string> = {}): Promise<{
  ws: WebSocket;
  events: unknown[];
  closed: Promise<{ code: number }>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.server.port}/admin/api/ws`, {
      headers,
    } as unknown as string);
    const events: unknown[] = [];
    const closed = new Promise<{ code: number }>((r) =>
      ws.addEventListener("close", (e) => r({ code: e.code })),
    );
    ws.addEventListener("message", (e) => {
      try {
        events.push(JSON.parse(e.data as string));
      } catch {
        events.push(e.data);
      }
    });
    ws.addEventListener("open", () => resolve({ ws, events, closed }));
    ws.addEventListener("error", () => {});
    setTimeout(() => reject(new Error("ws open timeout")), 2000);
  });
}

async function waitFor<T>(cond: () => T | undefined, timeoutMs = 1500): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = cond();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timeout");
}

describe("/admin/api/ws", () => {
  test("rejects connection without admin cookie", async () => {
    await expect(connect()).rejects.toThrow();
  });

  test("authenticated client receives conversation:updated when /take is called", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: 200 });
    const c = conversations.ensureForUser(u.id);

    const { ws, events } = await connect({ cookie });

    const res = await fetch(
      `http://127.0.0.1:${ctx.server.port}/admin/api/conversations/${c.id}/take`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(200);

    const evt = (await waitFor(() =>
      events.find(
        (e): e is { type: string; conversationId: number } =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "conversation:updated",
      ),
    )) as { type: string; conversationId: number };
    expect(evt.conversationId).toBe(c.id);

    ws.close();
  });

  test("receives message:new when a Telegram update is processed", async () => {
    const users = new UsersRepo(ctx.db);
    users.create({ tgUserId: 333 });

    const { ws, events } = await connect({ cookie });

    const res = await fetch(`http://127.0.0.1:${ctx.server.port}/telegram/s`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 333, is_bot: false, first_name: "X" },
          chat: { id: 333, type: "private" },
          date: 0,
          text: "hello",
        },
      }),
    });
    expect(res.status).toBe(200);

    const evt = (await waitFor(() =>
      events.find(
        (e): e is { type: string; tgUserId: number } =>
          typeof e === "object" && e !== null && (e as { type?: string }).type === "message:new",
      ),
    )) as { type: string; tgUserId: number };
    expect(evt.tgUserId).toBe(333);

    ws.close();
  });
});
