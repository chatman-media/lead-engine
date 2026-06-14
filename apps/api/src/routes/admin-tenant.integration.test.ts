// Integration test для admin-tenant pause/resume endpoint.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  applyAllMigrations,
	auditLog,
  createIsolatedDb,
  schema,
  tenantFeatureFlags,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminTenantRoutes } from "./admin-tenant.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_tenant_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-tenant-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;
let reloadCalls: number[] = [];

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
      makeAdminTenantRoutes({
        db,
        onStatusChange: async (tid) => {
          reloadCalls.push(tid);
        },
      }),
    );

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: "tenant-pause@demo.io",
			password: "strong-pwd-12345",
		}),
    });
	const sba = (await sa.json()) as {
		token: string;
		admin: { tenantId: number };
	};
    token = sba.token;
    tenantId = sba.admin.tenantId;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

describe("admin-tenant", () => {
  it("GET без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/tenant");
    expect(res.status).toBe(401);
  });

  it("GET /tenant → возвращает info", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/tenant");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
			tenant: {
				status: string;
				plan: string;
				llmBillingMode: string;
				slug: string;
			};
    };
    expect(body.tenant.status).toBe("active");
    expect(body.tenant.plan).toBe("free");
    expect(body.tenant.llmBillingMode).toBe("byok");
    expect(body.tenant.slug).toBeDefined();
  });

  it("PUT /reply-history-limit → сохраняет, GET отдаёт", async () => {
    if (!sql) return;
    const put = await authReq("/api/admin/tenant/reply-history-limit", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 8 }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ok: true, replyHistoryLimit: 8 });

    const get = await authReq("/api/admin/tenant");
    const body = (await get.json()) as { tenant: { replyHistoryLimit: number | null } };
    expect(body.tenant.replyHistoryLimit).toBe(8);
  });

  it("PUT /bot-settings → мёрджит patch, нормализует, GET отдаёт", async () => {
    if (!sql) return;
    // Частичный patch: только стоп-слова + клампинг температуры.
    const put1 = await authReq("/api/admin/tenant/bot-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stopWords: "Оператор, человек", temperature: 5, voiceStt: false }),
    });
    expect(put1.status).toBe(200);
    const b1 = (await put1.json()) as {
      ok: boolean;
      botSettings: { stopWords: string[]; temperature: number; voiceStt: boolean };
    };
    expect(b1.ok).toBe(true);
    expect(b1.botSettings.stopWords).toEqual(["оператор", "человек"]);
    expect(b1.botSettings.temperature).toBe(1.5); // клампинг
    expect(b1.botSettings.voiceStt).toBe(false);

    // Второй patch не затирает прежние поля (merge).
    const put2 = await authReq("/api/admin/tenant/bot-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autocloseHours: 48 }),
    });
    const b2 = (await put2.json()) as {
      botSettings: { stopWords: string[]; autocloseHours: number };
    };
    expect(b2.botSettings.stopWords).toEqual(["оператор", "человек"]); // сохранилось
    expect(b2.botSettings.autocloseHours).toBe(48);

    const get = await authReq("/api/admin/tenant");
    const body = (await get.json()) as {
      tenant: { botSettings: { autocloseHours: number; voiceStt: boolean } };
    };
    expect(body.tenant.botSettings.autocloseHours).toBe(48);
    expect(body.tenant.botSettings.voiceStt).toBe(false);
  });

  it("PUT /reply-history-limit { limit: null } → сброс в дефолт", async () => {
    if (!sql) return;
    const put = await authReq("/api/admin/tenant/reply-history-limit", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: null }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ok: true, replyHistoryLimit: null });
    const get = await authReq("/api/admin/tenant");
    const body = (await get.json()) as { tenant: { replyHistoryLimit: number | null } };
    expect(body.tenant.replyHistoryLimit).toBeNull();
  });

  it("PUT /reply-history-limit вне диапазона/дробное → 400", async () => {
    if (!sql) return;
    for (const bad of [1, 101, 3.5]) {
      const res = await authReq("/api/admin/tenant/reply-history-limit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: bad }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("PUT /status { paused: true } → status=suspended + onStatusChange triggered", async () => {
    if (!sql) return;
    reloadCalls = [];
    const res = await authReq("/api/admin/tenant/status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("suspended");

    // Verify DB row.
    const [t] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    expect(t!.status).toBe("suspended");

    // onStatusChange invoked exactly once.
    expect(reloadCalls).toEqual([tenantId]);
  });

  it("PUT /status снова true → noop, не вызывает onStatusChange", async () => {
    if (!sql) return;
    reloadCalls = [];
    const res = await authReq("/api/admin/tenant/status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(200);
    // Status осталось 'suspended', но onStatusChange НЕ вызван (noop).
    expect(reloadCalls).toEqual([]);
  });

  it("PUT /status { paused: false } → status=active", async () => {
    if (!sql) return;
    reloadCalls = [];
    const res = await authReq("/api/admin/tenant/status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("active");

    const [t] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    expect(t!.status).toBe("active");
    expect(reloadCalls).toEqual([tenantId]);
  });

  it("PUT /status без paused → 400", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/tenant/status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /status с не-boolean paused → 400", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/tenant/status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /status invalid json → 400", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/tenant/status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("GET/PUT /features/provider-relay управляет tenant rollout-флагом", async () => {
    if (!sql) return;

    const initial = await authReq("/api/admin/tenant/features");
    expect(initial.status).toBe(200);
		expect(await initial.json()).toEqual({
			features: { providerRelay: false, exchangeResponseGuard: true },
		});

    const enabled = await authReq("/api/admin/tenant/features/provider-relay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({
      ok: true,
      feature: "providerRelay",
      enabled: true,
    });

		const flagsAfterProvider = await db
      .select()
      .from(tenantFeatureFlags)
      .where(eq(tenantFeatureFlags.tenantId, tenantId));
		const providerFlag = flagsAfterProvider.find(
			(flag) => flag.featureKey === "provider_relay",
		);
		expect(providerFlag?.enabled).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "tenant_feature.update"));
    expect(audit?.targetId).toBe("provider_relay");

    const after = await authReq("/api/admin/tenant/features");
    expect(after.status).toBe(200);
		expect(await after.json()).toEqual({
			features: { providerRelay: true, exchangeResponseGuard: true },
		});

		const disabledGuard = await authReq(
			"/api/admin/tenant/features/exchange-response-guard",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			},
		);
		expect(disabledGuard.status).toBe(200);
		expect(await disabledGuard.json()).toEqual({
			ok: true,
			feature: "exchangeResponseGuard",
			enabled: false,
		});

		const flagsAfterGuard = await db
			.select()
			.from(tenantFeatureFlags)
			.where(eq(tenantFeatureFlags.tenantId, tenantId));
		const guardFlag = flagsAfterGuard.find(
			(flag) => flag.featureKey === "exchange_response_guard",
		);
		expect(guardFlag?.enabled).toBe(false);

		const afterGuard = await authReq("/api/admin/tenant/features");
		expect(afterGuard.status).toBe(200);
		expect(await afterGuard.json()).toEqual({
			features: { providerRelay: true, exchangeResponseGuard: false },
		});

    const invalid = await authReq("/api/admin/tenant/features/provider-relay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("PUT /status для deleted tenant → 409", async () => {
    if (!sql) return;
    // Mark tenant as deleted manually.
    await db
      .update(tenants)
      .set({ status: "deleted", updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tenants.id, tenantId));

    const res = await authReq("/api/admin/tenant/status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    expect(res.status).toBe(409);

    // Restore.
    await db
      .update(tenants)
      .set({ status: "active", updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tenants.id, tenantId));
  });

  it("tampered token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/tenant", {
      headers: { Authorization: "Bearer bad" },
    });
    expect(res.status).toBe(401);
  });
});
