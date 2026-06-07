import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminConciergeRoutes } from "./admin-concierge.ts";
import { makeAuthRoutes } from "./auth.ts";
import type { ConciergeCatalog } from "../lib/concierge-domain-tools.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_admin_concierge_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
  __dirname, "..", "..", "..", "..", "packages", "storage", "migrations",
);
const SECRET = "test-secret-admin-concierge-12345";
const MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tenantA = 0;
let tokenB = "";
let tenantB = 0;
let reloadCalls: number[] = [];

const MOCK_CATALOG: ConciergeCatalog = {
  transfer: {
    classes: [
      { id: "economy", name: "Эконом", priceBase: 500, currency: "THB", capacity: 3 },
      { id: "business", name: "Бизнес", priceBase: 1200, currency: "THB", capacity: 4 },
      { id: "minivan", name: "Минивэн", priceBase: 1800, currency: "THB", capacity: 7 },
    ],
  },
  food: {
    menu: [
      { id: "pizza", name: "Пицца Маргарита", price: 350, currency: "THB", category: "пицца" },
      { id: "sushi", name: "Суши сет 12 шт.", price: 480, currency: "THB", category: "суши" },
      { id: "cola", name: "Кола 0.5л", price: 80, currency: "THB", category: "напитки" },
    ],
    deliveryFee: 100,
    currency: "THB",
    etaMinutes: 45,
  },
  housekeeping: {
    ratePerHour: 400,
    currency: "THB",
    minHours: 2,
    availableSlots: ["10:00", "14:00", "18:00"],
  },
  tour: {
    options: [
      {
        id: "city_tour",
        name: "Обзорная экскурсия",
        duration: "3 часа",
        pricePerPerson: 1200,
        currency: "THB",
        minParticipants: 1,
        maxParticipants: 8,
      },
      {
        id: "beach_tour",
        name: "Пляжный тур",
        duration: "6 часов",
        pricePerPerson: 2200,
        currency: "THB",
        minParticipants: 2,
        maxParticipants: 10,
      },
    ],
  },
};

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });

  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  app = new Hono();
  app.route("/", makeAuthRoutes({ db: db as never, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route(
    "/",
    makeAdminConciergeRoutes({
      db,
      masterKeyHex: MASTER_KEY,
      onReload: (tenantId) => reloadCalls.push(tenantId),
    }),
  );

  const signupA = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "concierge-a@demo.io", password: "strong-pwd-12345" }),
  });
  const bodyA = (await signupA.json()) as { token: string; admin: { tenantId: number } };
  tokenA = bodyA.token;
  tenantA = bodyA.admin.tenantId;

  const signupB = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "concierge-b@demo.io", password: "strong-pwd-12345" }),
  });
  const bodyB = (await signupB.json()) as { token: string; admin: { tenantId: number } };
  tokenB = bodyB.token;
  tenantB = bodyB.admin.tenantId;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("admin-concierge routes", () => {
  it("requires auth for catalog endpoints", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/concierge/catalog");
    expect(res.status).toBe(401);
  });

  it("GET /catalog returns null when no catalog configured", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/concierge/catalog", {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { catalog: ConciergeCatalog | null };
    expect(body.catalog).toBeNull();
  });

  it("PUT /catalog saves catalog and triggers onReload", async () => {
    if (!sql) return;
    reloadCalls = [];

    const res = await app.request("/api/admin/concierge/catalog", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(MOCK_CATALOG),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; catalog: ConciergeCatalog };
    expect(body.ok).toBe(true);
    expect(body.catalog.transfer?.classes).toHaveLength(3);
    expect(body.catalog.food?.menu).toHaveLength(3);
    expect(body.catalog.housekeeping?.ratePerHour).toBe(400);
    expect(body.catalog.tour?.options).toHaveLength(2);
    expect(reloadCalls).toContain(tenantA);
  });

  it("GET /catalog returns saved catalog", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/concierge/catalog", {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { catalog: ConciergeCatalog };
    expect(body.catalog.transfer?.classes).toHaveLength(3);
    expect(body.catalog.food?.etaMinutes).toBe(45);
  });

  it("PUT /catalog rejects payload without any known section", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/concierge/catalog", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bogus: "data" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/transfer|food|housekeeping|tour/);
  });

  it("tenant isolation: tenantB cannot see tenantA catalog", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/concierge/catalog", {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { catalog: ConciergeCatalog | null };
    expect(body.catalog).toBeNull();
  });

  it("PUT /catalog for tenantB does not affect tenantA", async () => {
    if (!sql) return;
    const smallCatalog: ConciergeCatalog = {
      tour: {
        options: [{ id: "b_tour", name: "B тур", pricePerPerson: 999, currency: "THB" }],
      },
    };
    const putRes = await app.request("/api/admin/concierge/catalog", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(smallCatalog),
    });
    expect(putRes.status).toBe(200);

    // tenantA catalog unchanged
    const getA = await app.request("/api/admin/concierge/catalog", {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const bodyA2 = (await getA.json()) as { catalog: ConciergeCatalog };
    expect(bodyA2.catalog.transfer?.classes).toHaveLength(3); // still tenantA's data
  });

  it("DELETE /catalog removes catalog and triggers onReload", async () => {
    if (!sql) return;
    reloadCalls = [];

    const res = await app.request("/api/admin/concierge/catalog", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(reloadCalls).toContain(tenantA);

    // GET returns null now
    const getRes = await app.request("/api/admin/concierge/catalog", {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const getBody = (await getRes.json()) as { catalog: null };
    expect(getBody.catalog).toBeNull();
  });
});
