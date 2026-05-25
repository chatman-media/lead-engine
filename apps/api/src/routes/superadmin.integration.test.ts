// Integration tests для superadmin routes.
// Проверяем: только role=superadmin видит список тенантов и может менять план.
// Manager (role=manager) получает 403.
//
// Схема теста:
//   1. Signup tenant A → superadmin alice
//   2. Signup tenant B → superadmin bob
//   3. Invite manager в tenant A → accept → менеджер carol
//   4. Тесты GET /api/superadmin/tenants и PATCH /api/superadmin/tenants/:id/plan

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
import { makeAdminAdminsRoutes } from "./admin-admins.ts";
import { makeAuthRoutes } from "./auth.ts";
import { makeSuperadminRoutes } from "./superadmin.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_superadmin_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
  __dirname, "..", "..", "..", "..", "packages", "storage", "migrations",
);
const SECRET = "test-secret-superadmin-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;

let aliceToken = "";    // superadmin tenant A
let bobToken = "";      // superadmin tenant B
let carolToken = "";    // manager tenant A
let tenantAId = 0;
let tenantBId = 0;

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 });
    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    sql = postgres(testUrl, { max: 3, onnotice: () => {} });
    await applyAllMigrations(sql, migrationsDir);
    db = drizzle(sql, { schema });

    app = new Hono();
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
    app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    app.use("/api/superadmin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    app.route("/", makeAdminAdminsRoutes({ db, publicUrl: "https://app.test", inviteExpiresSec: 3600 }));
    app.route("/", makeSuperadminRoutes({ db }));

    // Signup alice (tenant A)
    const ra = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@sa-test.io", password: "password-alice-12345" }),
    });
    const sa = (await ra.json()) as { token: string; admin: { tenantId: number } };
    aliceToken = sa.token;
    tenantAId = sa.admin.tenantId;

    // Signup bob (tenant B)
    const rb = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bob@sa-test.io", password: "password-bob-12345" }),
    });
    const sb = (await rb.json()) as { token: string; admin: { tenantId: number } };
    bobToken = sb.token;
    tenantBId = sb.admin.tenantId;

    // Invite carol as manager in tenant A (alice invites)
    const ri = await app.request("/api/admin/admins/invite", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ email: "carol@sa-test.io", role: "manager" }),
    });
    const si = (await ri.json()) as { token: string; shareUrl: string };
    const inviteToken = new URL(si.shareUrl).searchParams.get("token") ?? "";

    // Accept invite
    const rac = await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "password-carol-12345" }),
    });
    const sac = (await rac.json()) as { token: string };
    carolToken = sac.token;
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

function authReq(token: string, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

describe("GET /api/superadmin/tenants", () => {
  it("superadmin (alice) видит список всех тенантов", async () => {
    if (!sql) return;
    const res = await authReq(aliceToken, "/api/superadmin/tenants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: number; slug: string; plan: string; status: string; leadCount: number; conversationCount: number }>;
    };
    expect(Array.isArray(body.items)).toBe(true);
    // Оба тенанта должны быть в списке
    const ids = body.items.map((t) => t.id);
    expect(ids).toContain(tenantAId);
    expect(ids).toContain(tenantBId);
    // Проверяем структуру первого элемента
    const tenantA = body.items.find((t) => t.id === tenantAId)!;
    expect(typeof tenantA.slug).toBe("string");
    expect(typeof tenantA.plan).toBe("string");
    expect(typeof tenantA.leadCount).toBe("number");
    expect(typeof tenantA.conversationCount).toBe("number");
  });

  it("manager (carol) → 403", async () => {
    if (!sql) return;
    const res = await authReq(carolToken, "/api/superadmin/tenants");
    expect(res.status).toBe(403);
  });

  it("без токена → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/superadmin/tenants");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/superadmin/tenants/:id/plan", () => {
  it("superadmin меняет план tenant B free → starter", async () => {
    if (!sql) return;
    const res = await authReq(bobToken, `/api/superadmin/tenants/${tenantBId}/plan`, {
      method: "PATCH",
      body: JSON.stringify({ plan: "starter" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; slug: string; plan: string };
    expect(body.id).toBe(tenantBId);
    expect(body.plan).toBe("starter");
  });

  it("план отражается в списке тенантов", async () => {
    if (!sql) return;
    const res = await authReq(aliceToken, "/api/superadmin/tenants");
    const body = (await res.json()) as { items: Array<{ id: number; plan: string }> };
    const tenantB = body.items.find((t) => t.id === tenantBId)!;
    expect(tenantB.plan).toBe("starter");
  });

  it("невалидный план → 400", async () => {
    if (!sql) return;
    const res = await authReq(aliceToken, `/api/superadmin/tenants/${tenantAId}/plan`, {
      method: "PATCH",
      body: JSON.stringify({ plan: "enterprise" }),
    });
    expect(res.status).toBe(400);
  });

  it("несуществующий id → 404", async () => {
    if (!sql) return;
    const res = await authReq(aliceToken, "/api/superadmin/tenants/999999/plan", {
      method: "PATCH",
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(res.status).toBe(404);
  });

  it("manager → 403", async () => {
    if (!sql) return;
    const res = await authReq(carolToken, `/api/superadmin/tenants/${tenantAId}/plan`, {
      method: "PATCH",
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(res.status).toBe(403);
  });
});
