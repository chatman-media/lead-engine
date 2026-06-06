// Integration test for admin-notifications (rules / settings / informer / ops /
// templates). Repo-backed (NotificationsRepo, no RLS on these tables); optional
// services left unset to exercise the "not configured" branches.
// Coverage epic #187 — apps/api untested routes.

import { NotificationsRepo } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminNotificationsRoutes } from "./admin-notifications.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_notif_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-notifications-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let appSvc: Hono; // вариант с сконфигуренными notificationService + opsRouter
let token = "";

const BASE = "/api/admin/notifications";

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 });
    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    sql = postgres(testUrl, { max: 2, onnotice: () => {} });
    await applyAllMigrations(sql, migrationsDir);
    db = drizzle(sql, { schema });

    app = new Hono();
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
    app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    // biome-ignore lint/suspicious/noExplicitAny: repo generic db
    const repo = new NotificationsRepo(db as any);
    app.route(BASE, makeAdminNotificationsRoutes({ repo, botUsername: "mybot" }));

    appSvc = new Hono();
    appSvc.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    appSvc.route(
      BASE,
      makeAdminNotificationsRoutes({
        repo,
        botUsername: "mybot",
        // biome-ignore lint/suspicious/noExplicitAny: minimal service fake
        notificationService: { sendTestMessage: async () => ({ ok: true }) } as any,
        // biome-ignore lint/suspicious/noExplicitAny: minimal ops-router fake
        opsRouter: { emit: async () => {} } as any,
        opsEmailConfigured: true,
      }),
    );

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "notif@demo.io", password: "strong-pwd-12345" }),
    });
    token = ((await sa.json()) as { token: string }).token;
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function req(method: string, path: string, body?: unknown, withAuth = true, instance?: Hono): Promise<Response> {
  return (instance ?? app).request(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("admin-notifications", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    expect((await req("GET", "/rules", undefined, false)).status).toBe(401);
  });

  it("rules: create → list → test(not configured) → delete", async () => {
    if (!sql) return;
    expect(((await (await req("GET", "/rules")).json()) as { items: unknown[] }).items).toEqual([]);

    const created = await req("POST", "/rules", { eventType: "stage_changed", targetId: "-100123", condition: { stage: "won" } });
    expect(created.status).toBe(201);
    const rule = (await created.json()) as { id: number };

    const list = (await (await req("GET", "/rules")).json()) as { items: Array<{ id: number }> };
    expect(list.items.length).toBe(1);

    // test на несуществующее → 404; на существующее без notificationService → ok:false
    expect((await req("POST", "/rules/999999/test")).status).toBe(404);
    const t = (await (await req("POST", `/rules/${rule.id}/test`)).json()) as { ok: boolean };
    expect(t.ok).toBe(false);

    expect((await req("DELETE", `/rules/${rule.id}`)).status).toBe(200);
    expect(((await (await req("GET", "/rules")).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("settings: get default → put → get reflects", async () => {
    if (!sql) return;
    const def = (await (await req("GET", "/settings")).json()) as { botUsername: string; notifyOnAssignedOnly: boolean };
    expect(def.botUsername).toBe("mybot");
    expect(def.notifyOnAssignedOnly).toBe(true);

    expect((await req("PUT", "/settings", { telegramChatId: "555", notifyOnAssignedOnly: false })).status).toBe(200);
    const upd = (await (await req("GET", "/settings")).json()) as { telegramChatId: string | null; notifyOnAssignedOnly: boolean };
    expect(upd.telegramChatId).toBe("555");
    expect(upd.notifyOnAssignedOnly).toBe(false);
  });

  it("link tokens: settings/link + group-link → возвращают token", async () => {
    if (!sql) return;
    expect(typeof ((await (await req("POST", "/settings/link")).json()) as { token: string }).token).toBe("string");
    expect(typeof ((await (await req("POST", "/group-link", { eventType: "stage_changed" })).json()) as { token: string }).token).toBe("string");
  });

  it("informer: feed + prefs update", async () => {
    if (!sql) return;
    const feed = (await (await req("GET", "/informer/feed?limit=5")).json()) as { items: unknown[] };
    expect(Array.isArray(feed.items)).toBe(true);
    expect((await req("PUT", "/informer", {
      informerLevel: "critical",
      informerDigest: "daily",
      informerDigestHour: 9,
      informerTz: "Asia/Bangkok",
      informerMutedUntil: null,
      informerTopics: { leads: true, orders: false },
    })).status).toBe(200);
  });

  it("ops: status (без роутера) + ops-test (не настроен)", async () => {
    if (!sql) return;
    const status = (await (await req("GET", "/ops-status")).json()) as { enabled: boolean; botConfigured: boolean; telegramLinked: boolean };
    expect(status.enabled).toBe(false);
    expect(status.botConfigured).toBe(true);
    expect(status.telegramLinked).toBe(true); // выставили telegramChatId в settings-тесте
    expect(((await (await req("POST", "/ops-test")).json()) as { ok: boolean }).ok).toBe(false);
  });

  it("templates: upsert → list → no body 400 → delete", async () => {
    if (!sql) return;
    expect((await req("PUT", "/templates/stage_changed", { body: "Привет {{name}}" })).status).toBe(200);
    expect((await req("PUT", "/templates/stage_changed", {})).status).toBe(400);
    const list = (await (await req("GET", "/templates")).json()) as { items: unknown[] };
    expect(list.items.length).toBe(1);
    expect((await req("DELETE", "/templates/stage_changed")).status).toBe(200);
    expect(((await (await req("GET", "/templates")).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("со сконфигуренными сервисами: rule/test + ops-test → ok:true", async () => {
    if (!sql) return;
    const created = await req("POST", "/rules", { eventType: "stage_changed", targetId: "-100" }, true, appSvc);
    const rule = (await created.json()) as { id: number };
    expect(((await (await req("POST", `/rules/${rule.id}/test`, undefined, true, appSvc)).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await req("POST", "/ops-test", undefined, true, appSvc)).json()) as { ok: boolean }).ok).toBe(true);
  });
});
