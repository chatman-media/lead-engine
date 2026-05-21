// Integration tests для admin-routes. Поднимает isolated Postgres, применяет
// все .sql миграции, seed'ит test-tenant + минимум data — и тестирует Hono
// app.request() с разными Host'ами (subdomain → tenant scope, apex → 404).
//
// Skip если DATABASE_URL не задан или PG недоступен.

import {
  applyAllMigrations,
  channels,
  conversations,
  contacts,
  createIsolatedDb,
  leads,
  messages,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeTenantContextMiddleware, requireTenant } from "../middleware/tenant-context.ts";
import { makeAdminRoutes } from "./admin.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_admin_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const BASE_DOMAIN = "test.local";

let sql: Sql | null = null;
// biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
let db: any;
let app: Hono;
let tenantId = 0;
let conversationId = 0;
let contactId = 0;
let leadId = 0;
const nowEpoch = Math.floor(Date.now() / 1000);

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 });
    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    sql = postgres(testUrl, { max: 2 });
    await applyAllMigrations(sql, migrationsDir);
    db = drizzle(sql);

    // Seed: tenant + channel + contact + conversation + message + lead.
    const [t] = await db
      .insert(tenants)
      .values({ slug: "alpha", plan: "free", status: "active", llmBillingMode: "byok" })
      .returning();
    tenantId = t.id;
    const [ch] = await db
      .insert(channels)
      .values({
        tenantId,
        kind: "telegram_bot",
        externalId: "alpha_bot",
        status: "active",
      })
      .returning();
    const [c] = await db
      .insert(contacts)
      .values({ tenantId, displayName: "Test User", attributesJson: null })
      .returning();
    contactId = c.id;
    const [conv] = await db
      .insert(conversations)
      .values({
        tenantId,
        userId: contactId,
        source: "bot",
        mode: "ai",
        lastMessageAt: nowEpoch,
      })
      .returning();
    conversationId = conv.id;
    await db.insert(messages).values({
      tenantId,
      conversationId,
      role: "user",
      text: "Привет",
      createdAt: nowEpoch,
    });
    const [l] = await db
      .insert(leads)
      .values({
        tenantId,
        userId: contactId,
        state: "intake_pending",
        createdAt: nowEpoch,
        updatedAt: nowEpoch,
      })
      .returning();
    leadId = l.id;
    void ch;

    // Build Hono app — symmetric to apps/api index.ts admin wire-up.
    app = new Hono();
    app.use("/admin/*", makeTenantContextMiddleware({ baseDomain: BASE_DOMAIN }));
    app.use("/admin/*", requireTenant);
    app.route("/", makeAdminRoutes({ db }));
  },
  30_000,
);

afterAll(
  async () => {
    if (sql) {
      await sql.end({ timeout: 0 }).catch(() => {});
      sql = null;
    }
  },
  10_000,
);

function tenantHost(slug: string): string {
  return `${slug}.${BASE_DOMAIN}`;
}

describe("admin-routes integration", () => {
  it("GET /admin/tenant возвращает tenant info", async () => {
    if (!sql) return;
    const res = await app.request("/admin/tenant", {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe("alpha");
    expect(body.id).toBe(tenantId);
    expect(body.plan).toBe("free");
  });

  it("GET /admin/me — placeholder с tenantSlug", async () => {
    if (!sql) return;
    const res = await app.request("/admin/me", {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tenantSlug).toBe("alpha");
    expect(body.adminId).toBe(null);
  });

  it("GET /admin/conversations возвращает seeded conversation", async () => {
    if (!sql) return;
    const res = await app.request("/admin/conversations", {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: number; userId: number }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(conversationId);
    expect(body.items[0]?.userId).toBe(contactId);
  });

  it("GET /admin/conversations/:id/messages → 1 message", async () => {
    if (!sql) return;
    const res = await app.request(`/admin/conversations/${conversationId}/messages`, {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ text: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.text).toBe("Привет");
  });

  it("GET /admin/leads/:id → seeded lead", async () => {
    if (!sql) return;
    const res = await app.request(`/admin/leads/${leadId}`, {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; state: string };
    expect(body.id).toBe(leadId);
    expect(body.state).toBe("intake_pending");
  });

  it("GET /admin/contacts/:id → seeded contact", async () => {
    if (!sql) return;
    const res = await app.request(`/admin/contacts/${contactId}`, {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; displayName: string };
    expect(body.id).toBe(contactId);
    expect(body.displayName).toBe("Test User");
  });

  it("GET /admin/styles → пустой list (нет seed'а styles)", async () => {
    if (!sql) return;
    const res = await app.request("/admin/styles", {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("GET /admin/experiments → пустой list", async () => {
    if (!sql) return;
    const res = await app.request("/admin/experiments", {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("GET /admin/skills/aggregates → пустой aggregates", async () => {
    if (!sql) return;
    const res = await app.request("/admin/skills/aggregates", {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("404 на apex host (нет tenant subdomain)", async () => {
    if (!sql) return;
    const res = await app.request("/admin/tenant", {
      headers: { Host: BASE_DOMAIN },
    });
    expect(res.status).toBe(404);
  });

  it("400 на spoofed host (не из baseDomain)", async () => {
    if (!sql) return;
    const res = await app.request("/admin/tenant", {
      headers: { Host: "evil.attacker.com" },
    });
    expect(res.status).toBe(400);
  });

  it("404 на unknown tenant subdomain (нет в БД)", async () => {
    if (!sql) return;
    const res = await app.request("/admin/tenant", {
      headers: { Host: tenantHost("nonexistent") },
    });
    expect(res.status).toBe(404);
  });

  it("400 на bad id (non-numeric)", async () => {
    if (!sql) return;
    const res = await app.request("/admin/leads/abc", {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(400);
  });

  it("404 на несуществующий lead id", async () => {
    if (!sql) return;
    const res = await app.request("/admin/leads/99999", {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(404);
  });
});
