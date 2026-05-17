import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
const COOKIE_NAME = "tg_admin_sid";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

function setup() {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({
    sql,
    telegram,
    webhookSecret: SECRET,
  });
  const server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  return { server };
}

function teardown(s: { server: Server }) {
  s.server.stop(true);
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

/** Create an admin, log in, return the session cookie header value. */
async function loginAs(
  email: string,
  password: string,
  role?: "superadmin" | "manager",
): Promise<string> {
  const admins = new AdminsRepo(sql);
  await admins.create(role ? { email, password, role } : { email, password });
  const login = await fetch(url("/admin/api/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = parseCookie(login.headers.get("set-cookie"))!;
  return `${cookie.name}=${cookie.value}`;
}

describe("POST /admin/api/login", () => {
  test("valid creds → 200, sets HttpOnly session cookie, returns admin email", async () => {
    const admins = new AdminsRepo(sql);
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
    const admins = new AdminsRepo(sql);
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
    const admins = new AdminsRepo(sql);
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
    const admins = new AdminsRepo(sql);
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

describe("admin role", () => {
  test("login + me return the role (superadmin by default)", async () => {
    const cookie = await loginAs("super@x.test", "longenough");
    const me = await fetch(url("/admin/api/me"), { headers: { cookie } });
    const body = (await me.json()) as { admin: { role: string } };
    expect(body.admin.role).toBe("superadmin");
  });

  test("a manager account carries role=manager", async () => {
    const cookie = await loginAs("mgr@x.test", "longenough", "manager");
    const me = await fetch(url("/admin/api/me"), { headers: { cookie } });
    const body = (await me.json()) as { admin: { role: string } };
    expect(body.admin.role).toBe("manager");
  });
});

describe("superadmin-gated endpoints", () => {
  test("manager → 403 on GET /admin/api/settings/runtime", async () => {
    const cookie = await loginAs("mgr2@x.test", "longenough", "manager");
    const res = await fetch(url("/admin/api/settings/runtime"), { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  test("superadmin → 200 on GET /admin/api/settings/runtime", async () => {
    const cookie = await loginAs("super2@x.test", "longenough", "superadmin");
    const res = await fetch(url("/admin/api/settings/runtime"), { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  test("no session → 401 (auth checked before role)", async () => {
    const res = await fetch(url("/admin/api/settings/runtime"));
    expect(res.status).toBe(401);
  });
});

describe("POST /admin/api/account/password", () => {
  test("changes the password — old creds stop working, new ones log in", async () => {
    const cookie = await loginAs("pwc@x.test", "old-password");
    const res = await fetch(url("/admin/api/account/password"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ current_password: "old-password", new_password: "new-password" }),
    });
    expect(res.status).toBe(200);

    const oldLogin = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "pwc@x.test", password: "old-password" }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "pwc@x.test", password: "new-password" }),
    });
    expect(newLogin.status).toBe(200);
  });

  test("wrong current password → 401", async () => {
    const cookie = await loginAs("pwc2@x.test", "longenough");
    const res = await fetch(url("/admin/api/account/password"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ current_password: "not-it", new_password: "new-password" }),
    });
    expect(res.status).toBe(401);
  });

  test("too-short new password → 400", async () => {
    const cookie = await loginAs("pwc3@x.test", "longenough");
    const res = await fetch(url("/admin/api/account/password"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ current_password: "longenough", new_password: "short" }),
    });
    expect(res.status).toBe(400);
  });

  test("no session → 401", async () => {
    const res = await fetch(url("/admin/api/account/password"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_password: "a", new_password: "longenough" }),
    });
    expect(res.status).toBe(401);
  });

  test("a manager can change their own password", async () => {
    const cookie = await loginAs("pwmgr@x.test", "old-password", "manager");
    const res = await fetch(url("/admin/api/account/password"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ current_password: "old-password", new_password: "new-password" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("operator management — /admin/api/admins", () => {
  test("GET — superadmin sees the list, manager → 403", async () => {
    const superCookie = await loginAs("om-super@x.test", "longenough", "superadmin");
    const mgrCookie = await loginAs("om-mgr@x.test", "longenough", "manager");

    const ok = await fetch(url("/admin/api/admins"), { headers: { cookie: superCookie } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { admins: Array<{ email: string }> };
    expect(body.admins.length).toBe(2);

    const denied = await fetch(url("/admin/api/admins"), { headers: { cookie: mgrCookie } });
    expect(denied.status).toBe(403);
  });

  test("POST — superadmin creates a manager who can then log in", async () => {
    const cookie = await loginAs("om-c@x.test", "longenough", "superadmin");
    const res = await fetch(url("/admin/api/admins"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: "new-mgr@x.test", password: "longenough", role: "manager" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { admin: { role: string } };
    expect(body.admin.role).toBe("manager");

    const login = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new-mgr@x.test", password: "longenough" }),
    });
    expect(login.status).toBe(200);
  });

  test("POST — duplicate email → 409, bad role → 400, short password → 400", async () => {
    const cookie = await loginAs("om-c2@x.test", "longenough", "superadmin");
    const dup = await fetch(url("/admin/api/admins"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: "om-c2@x.test", password: "longenough", role: "manager" }),
    });
    expect(dup.status).toBe(409);

    const badRole = await fetch(url("/admin/api/admins"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: "ok@x.test", password: "longenough", role: "owner" }),
    });
    expect(badRole.status).toBe(400);

    const shortPw = await fetch(url("/admin/api/admins"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: "ok2@x.test", password: "short", role: "manager" }),
    });
    expect(shortPw.status).toBe(400);
  });

  test("POST — manager → 403", async () => {
    const cookie = await loginAs("om-c3@x.test", "longenough", "manager");
    const res = await fetch(url("/admin/api/admins"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: "x@x.test", password: "longenough", role: "manager" }),
    });
    expect(res.status).toBe(403);
  });

  test("DELETE — superadmin removes another admin", async () => {
    const cookie = await loginAs("om-d@x.test", "longenough", "superadmin");
    const target = await new AdminsRepo(sql).create({
      email: "om-victim@x.test",
      password: "longenough",
      role: "manager",
    });
    const res = await fetch(url(`/admin/api/admins/${target.id}`), {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await new AdminsRepo(sql).byId(target.id)).toBeNull();
  });

  test("DELETE — cannot delete your own account → 400", async () => {
    const admins = new AdminsRepo(sql);
    const self = await admins.create({ email: "om-self@x.test", password: "longenough" });
    const login = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "om-self@x.test", password: "longenough" }),
    });
    const cookie = parseCookie(login.headers.get("set-cookie"))!;
    const res = await fetch(url(`/admin/api/admins/${self.id}`), {
      method: "DELETE",
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(res.status).toBe(400);
  });

  test("DELETE — unknown id → 404, manager → 403", async () => {
    const superCookie = await loginAs("om-d2@x.test", "longenough", "superadmin");
    const missing = await fetch(url("/admin/api/admins/999999"), {
      method: "DELETE",
      headers: { cookie: superCookie },
    });
    expect(missing.status).toBe(404);

    const mgrCookie = await loginAs("om-d3@x.test", "longenough", "manager");
    const target = await new AdminsRepo(sql).create({
      email: "om-d-victim@x.test",
      password: "longenough",
      role: "manager",
    });
    const denied = await fetch(url(`/admin/api/admins/${target.id}`), {
      method: "DELETE",
      headers: { cookie: mgrCookie },
    });
    expect(denied.status).toBe(403);
  });

  test("POST :id/password — superadmin resets another admin's password", async () => {
    const cookie = await loginAs("om-r@x.test", "longenough", "superadmin");
    const target = await new AdminsRepo(sql).create({
      email: "om-reset@x.test",
      password: "old-password",
      role: "manager",
    });
    const res = await fetch(url(`/admin/api/admins/${target.id}/password`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ new_password: "new-password" }),
    });
    expect(res.status).toBe(200);

    const oldLogin = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "om-reset@x.test", password: "old-password" }),
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await fetch(url("/admin/api/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "om-reset@x.test", password: "new-password" }),
    });
    expect(newLogin.status).toBe(200);
  });

  test("POST :id/password — manager → 403", async () => {
    const cookie = await loginAs("om-r2@x.test", "longenough", "manager");
    const target = await new AdminsRepo(sql).create({
      email: "om-r-target@x.test",
      password: "longenough",
      role: "manager",
    });
    const res = await fetch(url(`/admin/api/admins/${target.id}/password`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ new_password: "new-password" }),
    });
    expect(res.status).toBe(403);
  });
});
