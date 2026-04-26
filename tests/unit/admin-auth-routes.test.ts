import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { openDb } from "@/db/sqlite.ts";
import { TelegramClient, type FetchLike } from "@/telegram/client.ts";

const SECRET = "s";
const COOKIE_NAME = "tg_admin_sid";

function setup() {
  const db = openDb({ path: ":memory:" });
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({
    db,
    telegram,
    webhookSecret: SECRET,
  });
  const server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  return { db, server };
}

function teardown(s: { db: ReturnType<typeof openDb>; server: Server }) {
  s.server.stop(true);
  s.db.close();
}

let ctx: ReturnType<typeof setup>;

beforeEach(() => {
  ctx = setup();
});
afterEach(() => teardown(ctx));

function url(path: string): string {
  return `http://127.0.0.1:${ctx.server.port}${path}`;
}

function parseCookie(setCookie: string | null): {
  name: string;
  value: string;
  attrs: Record<string, string | true>;
} | null {
  if (!setCookie) return null;
  const [pair, ...rest] = setCookie.split(";").map((s) => s.trim());
  const [name, value] = pair!.split("=");
  const attrs: Record<string, string | true> = {};
  for (const a of rest) {
    const [k, v] = a.split("=");
    attrs[k!.toLowerCase()] = v ?? true;
  }
  return { name: name!, value: value ?? "", attrs };
}

describe("POST /admin/api/login", () => {
  test("valid creds → 200, sets HttpOnly session cookie, returns admin email", async () => {
    const admins = new AdminsRepo(ctx.db);
    await admins.create({ email: "op@x.test", password: "longenough" });

    const res = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { admin: { email: string } };
    expect(body.admin.email).toBe("op@x.test");

    const cookie = parseCookie(res.headers.get("set-cookie"));
    expect(cookie?.name).toBe(COOKIE_NAME);
    expect(cookie?.value.length).toBeGreaterThan(20);
    expect(cookie?.attrs.httponly).toBeTruthy();
    expect(cookie?.attrs.path).toBe("/");
    expect(cookie?.attrs.samesite).toBeTruthy();
  });

  test("wrong password → 401, no cookie", async () => {
    const admins = new AdminsRepo(ctx.db);
    await admins.create({ email: "x@y.test", password: "longenough" });

    const res = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.test", password: "wrong-one" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("unknown email → 401", async () => {
    const res = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@x.test", password: "longenough" }),
    });
    expect(res.status).toBe(401);
  });

  test("missing fields → 400", async () => {
    const res = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.test" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("/admin/api/* requires session", () => {
  test("GET /admin/api/me without cookie → 401", async () => {
    const res = await fetch(url("/admin/api/me"));
    expect(res.status).toBe(401);
  });

  test("GET /admin/api/me with valid cookie → 200 + admin email", async () => {
    const admins = new AdminsRepo(ctx.db);
    await admins.create({ email: "me@x.test", password: "longenough" });
    const login = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "me@x.test", password: "longenough" }),
    });
    const cookie = parseCookie(login.headers.get("set-cookie"))!;

    const res = await fetch(url("/admin/api/me"), {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { admin: { email: string } };
    expect(body.admin.email).toBe("me@x.test");
  });

  test("login route itself is public (no auth required)", async () => {
    const res = await fetch(url("/admin/api/login"), { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/api/logout", () => {
  test("clears the session and subsequent /admin/api/me returns 401", async () => {
    const admins = new AdminsRepo(ctx.db);
    await admins.create({ email: "lo@x.test", password: "longenough" });
    const login = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "lo@x.test", password: "longenough" }),
    });
    const cookie = parseCookie(login.headers.get("set-cookie"))!;

    const out = await fetch(url("/admin/api/logout"), {
      method: "POST",
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(out.status).toBe(200);
    const cleared = parseCookie(out.headers.get("set-cookie"));
    expect(cleared?.name).toBe(COOKIE_NAME);
    expect(cleared?.value).toBe("");

    const me = await fetch(url("/admin/api/me"), {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(me.status).toBe(401);
  });
});
