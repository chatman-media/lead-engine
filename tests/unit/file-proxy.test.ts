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
const KNOWN_FILE_ID = "AgADseen1234";
const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI

interface ScriptedFetchCalls {
  calls: string[];
}

/**
 * Fetches that pretends to be Telegram's Bot API:
 *   - /bot<TOKEN>/getFile → returns JSON with file_path
 *   - /file/bot<TOKEN>/<file_path> → returns the photo bytes with
 *     image/jpeg content-type
 */
function buildTelegramStub(): { client: TelegramClient; tracker: ScriptedFetchCalls } {
  const tracker: ScriptedFetchCalls = { calls: [] };
  const fetchImpl: FetchLike = async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    tracker.calls.push(url);
    if (url.includes("/getFile")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_id: KNOWN_FILE_ID,
            file_unique_id: "u1",
            file_path: "photos/file_1.jpg",
            file_size: PHOTO_BYTES.byteLength,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/file/bot")) {
      return new Response(PHOTO_BYTES, {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(PHOTO_BYTES.byteLength),
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    client: new TelegramClient({ token: "tok", fetch: fetchImpl }),
    tracker,
  };
}

let db: ReturnType<typeof openDb>;
let server: Server;
let cookie: string;
let tracker: ScriptedFetchCalls;

beforeEach(async () => {
  db = openDb({ path: ":memory:" });
  const tg = buildTelegramStub();
  tracker = tg.tracker;
  const router = createRouter({ db, telegram: tg.client, webhookSecret: SECRET });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });

  const admins = new AdminsRepo(db);
  await admins.create({ email: "op@x.test", password: "longenough" });
  const login = await fetch(
    `http://127.0.0.1:${server.port}/admin/api/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
    },
  );
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  // Seed one message that references KNOWN_FILE_ID via meta_json so
  // the endpoint's "have we seen this file?" gate passes.
  const u = new UsersRepo(db).create({ tgUserId: 7777 });
  const c = new ConversationsRepo(db).ensureForUser(u.id);
  new MessagesRepo(db).add({
    conversationId: c.id,
    role: "user",
    text: "[photo]",
    meta: { media: { type: "photo", file_id: KNOWN_FILE_ID } },
  });
});

afterEach(() => {
  server.stop(true);
  db.close();
});

function url(p: string) {
  return `http://127.0.0.1:${server.port}${p}`;
}

describe("GET /admin/api/tg-files/:fileId", () => {
  test("requires auth", async () => {
    const r = await fetch(url(`/admin/api/tg-files/${KNOWN_FILE_ID}`));
    expect(r.status).toBe(401);
  });

  test("streams the bytes for a known file_id", async () => {
    const r = await fetch(url(`/admin/api/tg-files/${KNOWN_FILE_ID}`), {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("cache-control")).toContain("private");
    const buf = new Uint8Array(await r.arrayBuffer());
    expect(buf.length).toBe(PHOTO_BYTES.byteLength);
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
    // Two upstream calls: getFile + file download.
    expect(tracker.calls.length).toBe(2);
    expect(tracker.calls[0]).toContain("/getFile");
    expect(tracker.calls[1]).toContain("/file/bot");
  });

  test("returns 404 for an unknown file_id (never seen in messages)", async () => {
    const r = await fetch(url(`/admin/api/tg-files/UnknownFileId123`), {
      headers: { cookie },
    });
    expect(r.status).toBe(404);
    // No upstream Telegram fetch happened (security gate before proxy).
    expect(tracker.calls.length).toBe(0);
  });

  test("file_id length cap rejects pathological input", async () => {
    const huge = "A".repeat(500);
    const r = await fetch(url(`/admin/api/tg-files/${huge}`), {
      headers: { cookie },
    });
    expect(r.status).toBe(400);
    expect(tracker.calls.length).toBe(0);
  });

  test("502 when Telegram getFile errors out", async () => {
    // Re-create with a fetch impl that rejects getFile.
    server.stop(true);
    db.close();
    db = openDb({ path: ":memory:" });
    const fetchImpl: FetchLike = async (input) => {
      const u = typeof input === "string" ? input : (input as Request).url;
      if (u.includes("/getFile")) {
        return new Response(
          JSON.stringify({ ok: false, description: "file not found" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("nope", { status: 404 });
    };
    const telegram = new TelegramClient({ token: "tok", fetch: fetchImpl });
    const router = createRouter({ db, telegram, webhookSecret: SECRET });
    server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
    const admins = new AdminsRepo(db);
    await admins.create({ email: "op@x.test", password: "longenough" });
    const login = await fetch(
      `http://127.0.0.1:${server.port}/admin/api/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
      },
    );
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const u = new UsersRepo(db).create({ tgUserId: 8888 });
    const c = new ConversationsRepo(db).ensureForUser(u.id);
    new MessagesRepo(db).add({
      conversationId: c.id,
      role: "user",
      text: "[photo]",
      meta: { media: { type: "photo", file_id: "FailFile" } },
    });

    const r = await fetch(url(`/admin/api/tg-files/FailFile`), {
      headers: { cookie },
    });
    expect(r.status).toBe(502);
  });
});
