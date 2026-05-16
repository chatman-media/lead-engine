// Coverage for the telegram-webhook, reseed and userbot-proxy ops routes
// in `src/admin/routes/ops.ts` not exercised by admin-ops-routes.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
const PROXY = "tg://proxy?server=1.2.3.4&port=8888&secret=dddeadbeefdeadbeefdeadbeefdeadbe";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let server: Server;
let cookie: string;

async function startServer(withTelegram: boolean) {
  const fetchImpl: FetchLike = async (input) => {
    const u = typeof input === "string" ? input : (input as Request).url;
    const result = u.includes("getWebhookInfo")
      ? { url: "https://bot.example.com/telegram/s", pending_update_count: 0 }
      : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  const router = createRouter({
    sql,
    ...(withTelegram ? { telegram: new TelegramClient({ token: "t", fetch: fetchImpl }) } : {}),
    webhookSecret: SECRET,
  });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  const admins = new AdminsRepo(sql);
  if (!(await admins.byEmail("op-opsproxies@x.test"))) {
    await admins.create({ email: "op-opsproxies@x.test", password: "longenough" });
  }
  const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op-opsproxies@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}

beforeEach(() => startServer(true), 30_000);
afterEach(() => server.stop(true));

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const authed = (extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: { ...(extra.headers ?? {}), cookie },
});

describe("GET /admin/api/ops/telegram/webhook", () => {
  test("returns webhook info from the Bot API", async () => {
    const res = await fetch(url("/admin/api/ops/telegram/webhook"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { info: { url: string } };
    expect(body.info.url).toContain("https://");
  });

  test("503 when no telegram client is configured", async () => {
    server.stop(true);
    await startServer(false);
    const res = await fetch(url("/admin/api/ops/telegram/webhook"), authed());
    expect(res.status).toBe(503);
  });
});

describe("PUT /admin/api/ops/telegram/webhook", () => {
  test("400 for a non-https url", async () => {
    const res = await fetch(
      url("/admin/api/ops/telegram/webhook"),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "http://insecure.example.com" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("sets the webhook and echoes back the info", async () => {
    const res = await fetch(
      url("/admin/api/ops/telegram/webhook"),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://bot.example.com", dropPending: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("POST /admin/api/ops/vacancies/reseed", () => {
  test("re-seeds the built-in Infinity vacancies", async () => {
    const res = await fetch(url("/admin/api/ops/vacancies/reseed"), authed({ method: "POST" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("userbot proxy routes", () => {
  test("GET returns an empty list initially", async () => {
    const res = await fetch(url("/admin/api/ops/userbot/proxies"), authed());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { proxies: unknown[] }).proxies).toEqual([]);
  });

  test("PUT replaces the list from a pasted block", async () => {
    const res = await fetch(
      url("/admin/api/ops/userbot/proxies"),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: PROXY }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { saved: number }).saved).toBe(1);

    const list = await fetch(url("/admin/api/ops/userbot/proxies"), authed());
    expect(((await list.json()) as { proxies: unknown[] }).proxies).toHaveLength(1);
  });

  test("PUT with empty text clears the list", async () => {
    const put = (text: string) =>
      fetch(
        url("/admin/api/ops/userbot/proxies"),
        authed({
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }),
      );
    await put(PROXY);
    const res = await put("  ");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cleared: boolean }).cleared).toBe(true);
    const list = await fetch(url("/admin/api/ops/userbot/proxies"), authed());
    expect(((await list.json()) as { proxies: unknown[] }).proxies).toEqual([]);
  });

  test("PUT with only garbage lines returns 400 without wiping", async () => {
    const res = await fetch(
      url("/admin/api/ops/userbot/proxies"),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "not-a-proxy\nalso garbage" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST clear-statuses resets last_status", async () => {
    const res = await fetch(
      url("/admin/api/ops/userbot/proxies/clear-statuses"),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("POST /admin/api/ops/kb/ingest", () => {
  test("503 when no embedder is configured", async () => {
    const res = await fetch(
      url("/admin/api/ops/kb/ingest"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "curated" }),
      }),
    );
    expect(res.status).toBe(503);
  });
});
