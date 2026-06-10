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
  kbDocuments,
  schema,
  styles as stylesTable,
  tryConnectToPg,
} from "@chatman-media/storage";
// Импорт ради side-effect: регистрирует EXCHANGE_V1 в defaultRegistry,
// который install handler читает через defaultRegistry.tryLoad(slug).
import { EXCHANGE_V1 } from "@chatman-media/vertical-exchange";
// Side-effect: регистрирует REAL_ESTATE_V1 (мульти-стилевой шаблон) —
// нужен для проверки, что install активирует ровно один стиль.
import { REAL_ESTATE_STYLES } from "@chatman-media/vertical-real-estate";
import { NullEmbeddingClient } from "@chatman-media/llm-router";
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
let embedder: NullEmbeddingClient;

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
    embedder = new NullEmbeddingClient(1536);

    app = new Hono();
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
    app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    app.route("/", makeAdminVerticalsRoutes({ db, resolveEmbedder: () => embedder }));

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

  it("install exchange_v1 сидит KB docs со scope воронки и стадии", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/verticals/exchange_v1/install", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      funnel?: { funnelId: number };
      kbDocuments?: { ingested?: number };
    };
    const expectedDocs = EXCHANGE_V1.kbDocuments?.length ?? 0;
    expect(body.kbDocuments?.ingested).toBe(expectedDocs);

    const rows = await db
      .select({
        title: kbDocuments.title,
        scopeType: kbDocuments.scopeType,
        funnelId: kbDocuments.funnelId,
        stageSlug: kbDocuments.stageSlug,
      })
      .from(kbDocuments)
      .where(eq(kbDocuments.tenantId, tenantId));
    const seededTitles = new Set(EXCHANGE_V1.kbDocuments?.map((doc) => doc.title) ?? []);
    const seeded = rows.filter((row) => seededTitles.has(row.title));
    expect(seeded.length).toBe(expectedDocs);
    expect(seeded.find((row) => row.scopeType === "funnel")?.funnelId).toBe(body.funnel?.funnelId);
    const stageDoc = seeded.find((row) => row.scopeType === "stage");
    expect(stageDoc?.funnelId).toBe(body.funnel?.funnelId);
    expect(stageDoc?.stageSlug).toBe("quote_calculated");
  });

  it("повторная установка (existing funnel) не теряет vertical_template_id", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/verticals/exchange_v1/install", { method: "POST" });
    expect(res.status).toBe(200);
    const funnel = await activeFunnel();
    expect(funnel.verticalTemplateId).toBe("exchange_v1");
  });

  it("install мульти-стилевого шаблона активирует ровно ОДИН стиль", async () => {
    if (!sql) return;
    // real_estate_v1 несёт несколько стилей (REAL_ESTATE_STYLES). Только
    // первый должен стать активным — иначе reply-движок берёт «самый свежий
    // активный» недетерминированно.
    expect(REAL_ESTATE_STYLES.length).toBeGreaterThan(1);
    const res = await authReq("/api/admin/verticals/real_estate_v1/install", { method: "POST" });
    expect(res.status).toBe(200);

    const rows = await db
      .select({ slug: stylesTable.slug, isActive: stylesTable.isActive })
      .from(stylesTable)
      .where(eq(stylesTable.tenantId, tenantId));
    const seeded = rows.filter((r) => REAL_ESTATE_STYLES.some((s) => s.slug === r.slug));
    expect(seeded.length).toBe(REAL_ESTATE_STYLES.length);
    expect(seeded.filter((r) => r.isActive).length).toBe(1);
    // активным должен быть первый стиль шаблона
    expect(seeded.find((r) => r.isActive)?.slug).toBe(REAL_ESTATE_STYLES[0]!.slug);
  });
});

describe("admin-verticals — GET list + неизвестный slug", () => {
  it("GET /api/admin/verticals → список вертикалей", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/verticals");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ slug: string; hasFunnel: boolean; hasStyles: boolean }>;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    const exchange = body.items.find((i) => i.slug === "exchange_v1");
    expect(exchange).toBeDefined();
    expect(typeof exchange!.hasFunnel).toBe("boolean");
  });

  it("POST install несуществующий slug → 404", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/verticals/nonexistent_v999/install", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("GET без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/verticals");
    expect(res.status).toBe(401);
  });
});
