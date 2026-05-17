import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { QuestionnaireTokensRepo } from "@/db/repos/questionnaire_tokens.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "test-secret";

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
  const server = Bun.serve({
    port: 0,
    fetch: (req) => router.handle(req),
  });
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

describe("GET /q/:token", () => {
  test("renders form with the token embedded when valid", async () => {
    const users = new UsersRepo(sql);
    const tokens = new QuestionnaireTokensRepo(sql);
    const u = await users.create({ tgUserId: 1, tgUsername: "alice" });
    await users.setStatus(u.id, "questionnaire_pending");
    const token = await tokens.issue(u.id);

    const res = await fetch(`http://127.0.0.1:${ctx.server.port}/q/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('action="/q/');
    expect(body).toContain(token);
    expect(body).toContain('name="name"');
    expect(body).toContain('name="email"');
    expect(body).toContain('name="goal"');
  });

  test("returns 404 for unknown / expired / used token", async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.server.port}/q/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

describe("POST /q/:token", () => {
  test("valid submission stores profile, sets status=qualified, marks token used", async () => {
    const users = new UsersRepo(sql);
    const tokens = new QuestionnaireTokensRepo(sql);
    const u = await users.create({ tgUserId: 2 });
    await users.setStatus(u.id, "questionnaire_pending");
    const token = await tokens.issue(u.id);

    const form = new URLSearchParams({
      name: "Alice",
      email: "a@b.test",
      goal: "Buy stuff",
    });
    const res = await fetch(`http://127.0.0.1:${ctx.server.port}/q/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect([200, 303]).toContain(res.status);

    const reloaded = await users.byId(u.id);
    expect(reloaded!.status).toBe("qualified");
    expect(reloaded!.profile_json).not.toBeNull();
    const profile = JSON.parse(reloaded!.profile_json!);
    expect(profile).toMatchObject({
      name: "Alice",
      email: "a@b.test",
      goal: "Buy stuff",
    });

    expect(await tokens.getValid(token)).toBeNull();

    const res2 = await fetch(`http://127.0.0.1:${ctx.server.port}/q/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(res2.status).toBe(404);
  });

  test("rejects invalid email with 400 and does NOT mark token used", async () => {
    const users = new UsersRepo(sql);
    const tokens = new QuestionnaireTokensRepo(sql);
    const u = await users.create({ tgUserId: 3 });
    await users.setStatus(u.id, "questionnaire_pending");
    const token = await tokens.issue(u.id);

    const form = new URLSearchParams({
      name: "Bob",
      email: "not-an-email",
      goal: "test",
    });
    const res = await fetch(`http://127.0.0.1:${ctx.server.port}/q/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(res.status).toBe(400);
    expect(await tokens.getValid(token)).not.toBeNull();
    expect((await users.byId(u.id))!.status).toBe("questionnaire_pending");
  });
});
