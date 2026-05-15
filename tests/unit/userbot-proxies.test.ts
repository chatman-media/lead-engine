// Coverage for the new admin-managed proxy list:
//   - UserbotProxiesRepo (replaceAll txn, markStatus, clearStatuses, hasAny)
//   - GET / PUT / clear-statuses admin endpoints
//   - PII redactor regression fixture covered separately in log.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { UserbotProxiesRepo } from "@/db/repos/userbot-proxies.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET_TOKEN = "s";
// Shape-valid placeholders — parser only checks charset+length, gramjs does
// the real handshake validation, and we never dial these in tests.
const SECRET = "dddeadbeefdeadbeefdeadbeefdeadbe";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

// ─── Repo ────────────────────────────────────────────────────────────

describe("UserbotProxiesRepo", () => {
  test("hasAny returns false on an empty table", async () => {
    expect(await new UserbotProxiesRepo(sql).hasAny()).toBe(false);
  });

  test("replaceAll persists rows in order; second call wipes + re-inserts", async () => {
    const repo = new UserbotProxiesRepo(sql);
    await repo.replaceAll([
      { raw: `a:443:${SECRET}`, parsed: { ip: "a", port: 443, secret: SECRET, MTProxy: true } },
      { raw: `b:443:${SECRET}`, parsed: { ip: "b", port: 443, secret: SECRET, MTProxy: true } },
    ]);
    let rows = await repo.list();
    expect(rows.map((r) => ({ host: r.parsed_host, pos: r.position }))).toEqual([
      { host: "a", pos: 0 },
      { host: "b", pos: 1 },
    ]);
    expect(await repo.hasAny()).toBe(true);

    // Second replaceAll completely supersedes the first.
    await repo.replaceAll([
      { raw: `c:443:${SECRET}`, parsed: { ip: "c", port: 443, secret: SECRET, MTProxy: true } },
    ]);
    rows = await repo.list();
    expect(rows.length).toBe(1);
    expect(rows[0]?.parsed_host).toBe("c");
  });

  test("replaceAll([]) clears the table", async () => {
    const repo = new UserbotProxiesRepo(sql);
    await repo.replaceAll([
      { raw: `a:443:${SECRET}`, parsed: { ip: "a", port: 443, secret: SECRET, MTProxy: true } },
    ]);
    await repo.replaceAll([]);
    expect(await repo.hasAny()).toBe(false);
  });

  test("markStatus updates last_status / last_tried_at / last_error / last_connect_ms", async () => {
    const repo = new UserbotProxiesRepo(sql);
    await repo.replaceAll([
      { raw: `a:443:${SECRET}`, parsed: { ip: "a", port: 443, secret: SECRET, MTProxy: true } },
    ]);
    const id = (await repo.list())[0]!.id;

    await repo.markStatus(id, "ok", { connectMs: 1234 });
    let reloaded = (await repo.list())[0]!;
    expect(reloaded.last_status).toBe("ok");
    expect(reloaded.last_tried_at).toBeGreaterThan(0);
    expect(reloaded.last_connect_ms).toBe(1234);
    expect(reloaded.last_error).toBeNull();

    await repo.markStatus(id, "timeout", { error: "TIMEOUT after 60000ms", connectMs: 60_000 });
    reloaded = (await repo.list())[0]!;
    expect(reloaded.last_status).toBe("timeout");
    expect(reloaded.last_error).toBe("TIMEOUT after 60000ms");
    expect(reloaded.last_connect_ms).toBe(60_000);
  });

  test("clearStatuses resets every row back to never_tried", async () => {
    const repo = new UserbotProxiesRepo(sql);
    await repo.replaceAll([
      { raw: `a:443:${SECRET}`, parsed: { ip: "a", port: 443, secret: SECRET, MTProxy: true } },
      { raw: `b:443:${SECRET}`, parsed: { ip: "b", port: 443, secret: SECRET, MTProxy: true } },
    ]);
    const ids = (await repo.list()).map((r) => r.id);
    await repo.markStatus(ids[0]!, "ok", { connectMs: 1000 });
    await repo.markStatus(ids[1]!, "timeout", { error: "TIMEOUT", connectMs: 60_000 });

    await repo.clearStatuses();
    const rows = await repo.list();
    for (const r of rows) {
      expect(r.last_status).toBe("never_tried");
      expect(r.last_tried_at).toBeNull();
      expect(r.last_error).toBeNull();
      expect(r.last_connect_ms).toBeNull();
    }
  });
});

// ─── Endpoints ───────────────────────────────────────────────────────

describe("admin endpoints — userbot proxies", () => {
  let server: Server;
  let cookie: string;

  beforeEach(async () => {
    const telegram = new TelegramClient({
      token: "t",
      fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as FetchLike,
    });
    const router = createRouter({ sql, telegram, webhookSecret: SECRET_TOKEN });
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

  afterEach(() => {
    server.stop(true);
  });

  function url(path: string) {
    return `http://127.0.0.1:${server.port}${path}`;
  }
  function authed(extra: RequestInit = {}): RequestInit {
    return { ...extra, headers: { ...(extra.headers ?? {}), cookie } };
  }

  test("GET requires auth + returns empty list on fresh DB", async () => {
    const unauth = await fetch(url("/admin/api/ops/userbot/proxies"));
    expect(unauth.status).toBe(401);

    const res = await fetch(url("/admin/api/ops/userbot/proxies"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proxies: unknown[] };
    expect(body.proxies).toEqual([]);
  });

  test("PUT saves valid lines, reports invalid line numbers, never exposes secret in GET", async () => {
    const text = [
      `# comment line`,
      `host-1:443:${SECRET}`, // line 2 — ok
      `garbage`, // line 3 — bad
      `host-2:2053:${SECRET}`, // line 4 — ok
      ``,
    ].join("\n");
    const put = await fetch(
      url("/admin/api/ops/userbot/proxies"),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }),
    );
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { saved: number; invalid_lines: number[] };
    expect(putBody).toEqual({ saved: 2, invalid_lines: [3] });

    // GET reflects the saved entries in order, without the secret.
    const get = await fetch(url("/admin/api/ops/userbot/proxies"), authed());
    const getBody = (await get.json()) as {
      proxies: Array<{ host: string; port: number; raw: string; last_status: string }>;
    };
    expect(getBody.proxies.length).toBe(2);
    expect(getBody.proxies[0]?.host).toBe("host-1");
    expect(getBody.proxies[1]?.host).toBe("host-2");
    expect(getBody.proxies[0]?.last_status).toBe("never_tried");
    // raw is the round-trippable input, secret is NOT a top-level key.
    expect(getBody.proxies[0]?.raw).toContain(SECRET);
    expect(Object.keys(getBody.proxies[0]!)).not.toContain("secret");
    expect(Object.keys(getBody.proxies[0]!)).not.toContain("parsed_secret");
  });

  test("PUT with empty text body clears the list (returns saved: 0, cleared: true)", async () => {
    // Seed something first.
    await new UserbotProxiesRepo(sql).replaceAll([
      { raw: `a:443:${SECRET}`, parsed: { ip: "a", port: 443, secret: SECRET, MTProxy: true } },
    ]);

    const put = await fetch(
      url("/admin/api/ops/userbot/proxies"),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "" }),
      }),
    );
    expect(put.status).toBe(200);
    const body = (await put.json()) as { saved: number; cleared?: boolean };
    expect(body.saved).toBe(0);
    expect(body.cleared).toBe(true);

    expect(await new UserbotProxiesRepo(sql).hasAny()).toBe(false);
  });

  test("PUT with all-invalid text returns 400 and does NOT touch the existing list", async () => {
    const repo = new UserbotProxiesRepo(sql);
    await repo.replaceAll([
      {
        raw: `kept:443:${SECRET}`,
        parsed: { ip: "kept", port: 443, secret: SECRET, MTProxy: true },
      },
    ]);

    const put = await fetch(
      url("/admin/api/ops/userbot/proxies"),
      authed({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "garbage1\ngarbage2\n" }),
      }),
    );
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string; invalid_lines: number[] };
    expect(body.error).toMatch(/no valid proxies/);
    expect(body.invalid_lines).toEqual([1, 2]);

    // The pre-existing row survived.
    expect((await repo.list())[0]?.parsed_host).toBe("kept");
  });

  test("clear-statuses resets all rows and writes audit row", async () => {
    const repo = new UserbotProxiesRepo(sql);
    await repo.replaceAll([
      { raw: `a:443:${SECRET}`, parsed: { ip: "a", port: 443, secret: SECRET, MTProxy: true } },
    ]);
    const id = (await repo.list())[0]!.id;
    await repo.markStatus(id, "timeout", { error: "TIMEOUT", connectMs: 60_000 });

    const res = await fetch(
      url("/admin/api/ops/userbot/proxies/clear-statuses"),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(200);

    const reloaded = (await repo.list())[0]!;
    expect(reloaded.last_status).toBe("never_tried");
    expect(reloaded.last_error).toBeNull();

    const [audit] = await sql<
      { action: string }[]
    >`SELECT action FROM audit_log WHERE action = 'userbot.proxies.clear_statuses'`;
    expect(audit?.action).toBe("userbot.proxies.clear_statuses");
  });
});
