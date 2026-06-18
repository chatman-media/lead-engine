// Integration test для M4 multi-admin invite flow.
// Signup superadmin → invite → accept-invite (новый admin) → list / revoke.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  adminInvites,
  admins,
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminAdminsRoutes } from "./admin-admins.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_invites_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "storage",
  "migrations",
);
const SECRET = "test-secret-invite-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let superadminToken = "";
let superadminTenantId = 0;
let superadminAdminId = 0;
let managerToken = "";
let secondTenantToken = "";

beforeAll(async () => {
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
  app.route(
    "/",
    makeAdminAdminsRoutes({ db, publicUrl: "https://app.test", inviteExpiresSec: 60 * 60 }),
  );

  // Superadmin (signup создаёт superadmin role).
  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "boss@demo.io", password: "strong-pwd-12345" }),
  });
  const sba = (await sa.json()) as {
    token: string;
    admin: { id: number; tenantId: number };
  };
  superadminToken = sba.token;
  superadminTenantId = sba.admin.tenantId;
  superadminAdminId = sba.admin.id;

  // Second tenant — для cross-tenant guard.
  const sb = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "boss-other@demo.io", password: "strong-pwd-12345" }),
  });
  secondTenantToken = ((await sb.json()) as { token: string }).token;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

describe("admin-admins invite flow", () => {
  it("GET /admins без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/admins");
    expect(res.status).toBe(401);
  });

  it("GET /admins → returns superadmin", async () => {
    if (!sql) return;
    const res = await authReq(superadminToken, "/api/admin/admins");
    const body = (await res.json()) as { items: Array<{ email: string; role: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.email).toBe("boss@demo.io");
    expect(body.items[0]!.role).toBe("superadmin");
  });

  let inviteToken = "";
  let inviteId = 0;

  it("POST /invite — invalid email → 400", async () => {
    if (!sql) return;
    const res = await authReq(superadminToken, "/api/admin/admins/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /invite — happy path → token + shareUrl", async () => {
    if (!sql) return;
    const res = await authReq(superadminToken, "/api/admin/admins/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "newhire@demo.io", role: "manager" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      id: number;
      token: string;
      shareUrl: string;
      email: string;
      role: string;
      expiresAt: number;
    };
    expect(body.ok).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/); // 32 байт hex
    expect(body.shareUrl).toContain("https://app.test/accept-invite?token=");
    expect(body.email).toBe("newhire@demo.io");
    expect(body.role).toBe("manager");
    inviteToken = body.token;
    inviteId = body.id;
  });

  it("POST /invite — dup email с существующим admin → 409", async () => {
    if (!sql) return;
    const res = await authReq(superadminToken, "/api/admin/admins/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "boss@demo.io", role: "manager" }),
    });
    expect(res.status).toBe(409);
  });

  it("GET /invites → отображает pending invite", async () => {
    if (!sql) return;
    const res = await authReq(superadminToken, "/api/admin/admins/invites");
    const body = (await res.json()) as {
      items: Array<{ email: string; status: string }>;
    };
    const newhire = body.items.find((i) => i.email === "newhire@demo.io");
    expect(newhire?.status).toBe("pending");
  });

  it("POST /accept-invite — short password → 400", async () => {
    if (!sql) return;
    const res = await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /accept-invite — invalid token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "nonexistent-token", password: "strong-pwd-12345" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /accept-invite — happy path → возвращает session + создаёт admin", async () => {
    if (!sql) return;
    const res = await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "strong-pwd-12345" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      admin: { id: number; email: string; role: string; tenantId: number };
    };
    expect(body.admin.email).toBe("newhire@demo.io");
    expect(body.admin.role).toBe("manager");
    expect(body.admin.tenantId).toBe(superadminTenantId);
    expect(body.token.length).toBeGreaterThan(20); // signed token

    managerToken = body.token;

    // Verify admin row создан в БД.
    const [adminRow] = await db.select().from(admins).where(eq(admins.email, "newhire@demo.io"));
    expect(adminRow).toBeDefined();
    expect(adminRow!.tenantId).toBe(superadminTenantId);

    // Invite помечен usedAt + acceptedAdminId.
    const [invite] = await db.select().from(adminInvites).where(eq(adminInvites.id, inviteId));
    expect(invite!.usedAt).not.toBeNull();
    expect(invite!.acceptedAdminId).toBe(adminRow!.id);
  });

  it("POST /accept-invite повторно с тем же token → 409 (already used)", async () => {
    if (!sql) return;
    const res = await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "strong-pwd-12345" }),
    });
    expect(res.status).toBe(409);
  });

  it("manager НЕ может приглашать → 403", async () => {
    if (!sql) return;
    const res = await authReq(managerToken, "/api/admin/admins/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "next@demo.io" }),
    });
    expect(res.status).toBe(403);
  });

  it("manager может GET /admins (read-only)", async () => {
    if (!sql) return;
    const res = await authReq(managerToken, "/api/admin/admins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ email: string }> };
    expect(body.items.length).toBe(1); // only self — managers see only admins they personally invited
  });

  let secondInviteId = 0;

  it("POST /invite + DELETE revoke (pending) → 200", async () => {
    if (!sql) return;
    const create = await authReq(superadminToken, "/api/admin/admins/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tobe-revoked@demo.io" }),
    });
    const cb = (await create.json()) as { id: number };
    secondInviteId = cb.id;

    const del = await authReq(superadminToken, `/api/admin/admins/invites/${secondInviteId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    // Verify row deleted.
    const rows = await db.select().from(adminInvites).where(eq(adminInvites.id, secondInviteId));
    expect(rows).toHaveLength(0);
  });

  it("DELETE accepted invite → 409", async () => {
    if (!sql) return;
    const del = await authReq(superadminToken, `/api/admin/admins/invites/${inviteId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(409);
  });

  it("DELETE non-existent → 404", async () => {
    if (!sql) return;
    const del = await authReq(superadminToken, "/api/admin/admins/invites/999999", {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
  });

  it("expired invite — accept → 401", async () => {
    if (!sql) return;
    // Insert manually expired invite directly через DB (без endpoint —
    // proxy для time-travel).
    const expiredToken = "deadbeef".repeat(8); // 64 hex
    const past = Math.floor(Date.now() / 1000) - 86400; // 1 день назад
    await db.insert(adminInvites).values({
      tenantId: superadminTenantId,
      email: "expired@demo.io",
      role: "manager",
      token: expiredToken,
      invitedByAdminId: superadminAdminId,
      expiresAt: past,
      createdAt: past,
    });

    const res = await app.request("/api/auth/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: expiredToken, password: "strong-pwd-12345" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("expired");
  });

  it("cross-tenant: tenant B не видит invite tenant'а A", async () => {
    if (!sql) return;
    const res = await authReq(secondTenantToken, "/api/admin/admins/invites");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
