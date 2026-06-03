// Integration test для admin-verticals install endpoint. Проверяет, что после
// установки вертикали funnels.vertical_template_id выставлен в registry slug
// (напр. "exchange_v1") — это ключ, по которому runtime (index.ts →
// resolveTemplate) и onboarding-детекция находят VerticalTemplate. Раньше
// install сеял только funnels.slug (funnelSeedKey, напр. "exchange"), оставляя
// vertical_template_id NULL, из-за чего бот запускался без systemPromptFragment.

import {
  applyAllMigrations,
  createIsolatedDb,
  funnels,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
// Импорт ради side-effect: регистрирует EXCHANGE_V1 в defaultRegistry,
// который install handler читает через defaultRegistry.tryLoad(slug).
import { EXCHANGE_V1 } from "@chatman-media/vertical-exchange";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminVerticalsRoutes } from "./admin-verticals.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_vert_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-vert-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;

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
    app.route("/", makeAdminVerticalsRoutes({ db }));

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "vert@demo.io", password: "strong-pwd-12345" }),
    });
    const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
    token = sba.token;
    tenantId = sba.admin.tenantId;
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(path: string, init: RequestInit = {}): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

async function activeFunnel(): Promise<{ slug: string; verticalTemplateId: string | null }> {
  const [row] = await db
    .select({ slug: funnels.slug, verticalTemplateId: funnels.verticalTemplateId })
    .from(funnels)
    .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
    .limit(1);
  return row!;
}

describe("admin-verticals install → vertical_template_id", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/verticals/exchange_v1/install", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("install exchange_v1 ставит funnels.vertical_template_id = registry slug", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/verticals/exchange_v1/install", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      slug: string;
      funnel?: { funnelId: number; verticalTemplateId: string };
    };
    expect(body.ok).toBe(true);
    expect(body.funnel?.verticalTemplateId).toBe("exchange_v1");

    const funnel = await activeFunnel();
    // funnels.slug остаётся funnelSeedKey ("exchange"), а vertical_template_id —
    // registry slug ("exchange_v1"), совпадающий с EXCHANGE_V1.slug.
    expect(funnel.slug).toBe("exchange");
    expect(funnel.verticalTemplateId).toBe("exchange_v1");
    // resolveTemplate(tenantSlug) в runtime делает KNOWN_TEMPLATES[verticalTemplateId];
    // ключ совпадает с EXCHANGE_V1.slug, значит lookup нашёл бы шаблон.
    expect(funnel.verticalTemplateId).toBe(EXCHANGE_V1.slug);
  });

  it("повторная установка (existing funnel) не теряет vertical_template_id", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/verticals/exchange_v1/install", { method: "POST" });
    expect(res.status).toBe(200);
    const funnel = await activeFunnel();
    expect(funnel.verticalTemplateId).toBe("exchange_v1");
  });
});
