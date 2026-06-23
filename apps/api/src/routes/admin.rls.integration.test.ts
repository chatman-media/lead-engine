// E2E проверка что admin-routes работают под non-BYPASSRLS Postgres
// role'ью с FORCE ROW LEVEL SECURITY активным (production-like setup).
//
// Симметричен apps/worker/src/dispatcher.rls.integration.test.ts:
// если кто-то откатит withTenant из admin.ts handler'ов, тест поймает
// (GET /admin/conversations вернул бы [] под non-bypass role).

import {
  applyAllMigrations,
  channels,
  contacts,
  conversations,
  createIsolatedDb,
  leads,
  messages,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeTenantContextMiddleware, requireTenant } from "../middleware/tenant-context.ts";
import { makeAdminRoutes } from "./admin.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_admin_rls_${Math.random().toString(36).slice(2, 10)}`;
const appRoleName = `app_admin_rls_${Math.random().toString(36).slice(2, 8)}`;
const appRolePass = "test-pass-admin-rls";
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
const BASE_DOMAIN = "test.local";

let ownerSql: Sql | null = null;
let appSql: Sql | null = null;
let appDb: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tenantId = 0;
let conversationId = 0;
let contactId = 0;
let leadId = 0;
const nowEpoch = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });

  ownerSql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(ownerSql, migrationsDir);
  // FORCE RLS остаётся активным — production-like setup.

  await ownerSql.unsafe(`
      CREATE ROLE "${appRoleName}" LOGIN PASSWORD '${appRolePass}' NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO "${appRoleName}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${appRoleName}";
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appRoleName}";
    `);

  const ownerDb = drizzle(ownerSql, { schema });
  const [t] = await ownerDb
    .insert(tenants)
    .values({ slug: "rls-admin", plan: "free", status: "active", llmBillingMode: "byok" })
    .returning();
  if (!t) throw new Error("seed tenant");
  tenantId = t.id;
  await ownerDb
    .insert(channels)
    .values({ tenantId, kind: "telegram_bot", externalId: "rls-admin-bot", status: "active" });
  const [contact] = await ownerDb
    .insert(contacts)
    .values({ tenantId, displayName: "User RLS", attributesJson: null })
    .returning();
  if (!contact) throw new Error("seed contact");
  contactId = contact.id;
  const [conv] = await ownerDb
    .insert(conversations)
    .values({
      tenantId,
      userId: contactId,
      source: "bot",
      mode: "ai",
      lastMessageAt: nowEpoch,
    })
    .returning();
  if (!conv) throw new Error("seed conversation");
  conversationId = conv.id;
  await ownerDb.insert(messages).values({
    tenantId,
    conversationId,
    role: "user",
    text: "RLS hello",
    createdAt: nowEpoch,
  });
  const [l] = await ownerDb
    .insert(leads)
    .values({
      tenantId,
      userId: contactId,
      state: "intake_pending",
      createdAt: nowEpoch,
      updatedAt: nowEpoch,
    })
    .returning();
  if (!l) throw new Error("seed lead");
  leadId = l.id;

  // Hono app под app-role'ью (non-bypass).
  const parsed = new URL(testUrl);
  parsed.username = appRoleName;
  parsed.password = appRolePass;
  appSql = postgres(parsed.toString(), { max: 4, onnotice: () => {} });
  appDb = drizzle(appSql, { schema });

  app = new Hono();
  app.use("/admin/*", makeTenantContextMiddleware({ baseDomain: BASE_DOMAIN }));
  app.use("/admin/*", requireTenant);
  app.route("/", makeAdminRoutes({ db: appDb }));
}, 30_000);

afterAll(async () => {
  if (appSql) {
    await appSql.end({ timeout: 0 }).catch(() => {});
    appSql = null;
  }
  if (ownerSql) {
    await ownerSql
      .unsafe(`DROP OWNED BY "${appRoleName}"; DROP ROLE IF EXISTS "${appRoleName}"`)
      .catch(() => {});
    await ownerSql.end({ timeout: 0 }).catch(() => {});
    ownerSql = null;
  }
}, 10_000);

function tenantHost(slug: string): string {
  return `${slug}.${BASE_DOMAIN}`;
}

describe("admin-routes under FORCE RLS / non-BYPASSRLS role", () => {
  it("sanity: app role действительно non-bypass", async () => {
    if (!appSql) return;
    const rows = await appSql<Array<{ sup: boolean; bypass: boolean }>>`
      SELECT rolsuper as sup, rolbypassrls as bypass FROM pg_roles WHERE rolname = current_user
    `;
    expect(rows[0]?.sup).toBe(false);
    expect(rows[0]?.bypass).toBe(false);
  });

  it("GET /admin/conversations возвращает seeded conversation (RLS-correct)", async () => {
    if (!appSql) return;
    const res = await app.request("/admin/conversations", {
      headers: { Host: tenantHost("rls-admin") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: number; userId: number }> };
    // Без withTenant в admin.ts здесь был бы [] — proof что wiring on.
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(conversationId);
  });

  it("GET /admin/conversations/:id/messages → seeded message", async () => {
    if (!appSql) return;
    const res = await app.request(`/admin/conversations/${conversationId}/messages`, {
      headers: { Host: tenantHost("rls-admin") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ text: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.text).toBe("RLS hello");
  });

  it("GET /admin/contacts/:id → seeded contact", async () => {
    if (!appSql) return;
    const res = await app.request(`/admin/contacts/${contactId}`, {
      headers: { Host: tenantHost("rls-admin") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; displayName: string };
    expect(body.id).toBe(contactId);
    expect(body.displayName).toBe("User RLS");
  });

  it("GET /admin/leads/:id → seeded lead", async () => {
    if (!appSql) return;
    const res = await app.request(`/admin/leads/${leadId}`, {
      headers: { Host: tenantHost("rls-admin") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; state: string };
    expect(body.id).toBe(leadId);
    expect(body.state).toBe("intake_pending");
  });

  it("GET /admin/tenant — tenant info видна (tenants table вне RLS-policy)", async () => {
    if (!appSql) return;
    const res = await app.request("/admin/tenant", {
      headers: { Host: tenantHost("rls-admin") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe("rls-admin");
  });
});
