import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { withTenant } from "@chatman-media/conversation-engine";
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
import { makeAdminProvidersRoutes } from "./admin-providers.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_providers_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-provider-admin-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;
let channelId = 0;

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
  app.route("/", makeAdminProvidersRoutes({ db }));

  const signup = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "providers@demo.io", password: "strong-pwd-12345" }),
  });
  const signupBody = (await signup.json()) as {
    token: string;
    tenant: { id: number };
  };
  token = signupBody.token;
  tenantId = signupBody.tenant.id;

  const [channel] = await withTenant(db, tenantId, (tx) =>
    tx
      .insert(schema.channels)
      .values({
        tenantId,
        kind: "whatsapp",
        externalId: "wa-business-1",
        status: "active",
        metadataJson: JSON.stringify({ phone: "+66123456789" }),
      })
      .returning({ id: schema.channels.id }),
  );
  if (!channel) throw new Error("channel insert returned no row");
  channelId = channel.id;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe("admin providers", () => {
  it("creates, lists, updates and archives provider profiles with services", async () => {
    if (!sql) return;

    const createRes = await authReq("/api/admin/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Lotus Spa",
        category: "massage",
        serviceArea: "Phuket",
        defaultCommissionPct: 20,
        notes: "prefers WhatsApp",
        whatsappOptIn: {
          source: "admin_form",
          acceptedAt: 1_780_000_000,
          categories: ["utility"],
        },
        whatsappProviderRequestTemplate: {
          name: "provider_request_v1",
          languageCode: "en_US",
          category: "utility",
          approved: true,
        },
        identity: { channelId, externalUserId: "lotus-spa-wa" },
        services: [{ serviceType: "massage", name: "Thai massage", commissionPct: 18 }],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      item: {
        id: number;
        status: string;
        category: string | null;
        servicesCount: number;
        activeServicesCount: number;
        metadataJson: string;
        identities: Array<{ channelId: number; externalUserId: string }>;
        services: Array<{ id: number; serviceType: string; name: string; commissionPct: number | null }>;
      };
    };
    expect(created.item.category).toBe("massage");
    expect(created.item.servicesCount).toBe(1);
    expect(created.item.activeServicesCount).toBe(1);
    expect(created.item.identities).toContainEqual(
      expect.objectContaining({ channelId, externalUserId: "lotus-spa-wa" }),
    );
    expect(JSON.parse(created.item.metadataJson)).toMatchObject({
      whatsappOptIn: {
        source: "admin_form",
        acceptedAt: 1_780_000_000,
        categories: ["utility"],
      },
      whatsappProviderRequestTemplate: {
        name: "provider_request_v1",
        languageCode: "en_US",
        category: "utility",
        approved: true,
      },
    });
    expect(created.item.services[0]).toEqual(
      expect.objectContaining({ serviceType: "massage", name: "Thai massage", commissionPct: 18 }),
    );

    const listRes = await authReq("/api/admin/providers");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Array<{ id: number; name: string }> };
    expect(list.items).toContainEqual(expect.objectContaining({ id: created.item.id, name: "Lotus Spa" }));

    const updateRes = await authReq(`/api/admin/providers/${created.item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused", serviceArea: "Phuket, Rawai" }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { item: { status: string; serviceArea: string | null } };
    expect(updated.item.status).toBe("paused");
    expect(updated.item.serviceArea).toBe("Phuket, Rawai");

    const service = created.item.services[0];
    expect(service).toBeTruthy();
    if (!service) return;
    const serviceId = service.id;
    const serviceUpdateRes = await authReq(`/api/admin/provider-services/${serviceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    expect(serviceUpdateRes.status).toBe(200);
    const serviceUpdated = (await serviceUpdateRes.json()) as { item: { activeServicesCount: number } };
    expect(serviceUpdated.item.activeServicesCount).toBe(0);

    const archiveRes = await authReq(`/api/admin/providers/${created.item.id}/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(200);
    const archived = (await archiveRes.json()) as { item: { status: string } };
    expect(archived.item.status).toBe("archived");
  });

  it("rejects duplicate channel identity attachment", async () => {
    if (!sql) return;

    const firstRes = await authReq("/api/admin/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ocean Massage",
        category: "massage",
        identity: { channelId, externalUserId: "shared-wa-id" },
      }),
    });
    expect(firstRes.status).toBe(201);

    const secondRes = await authReq("/api/admin/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Palm Massage", category: "massage" }),
    });
    expect(secondRes.status).toBe(201);
    const second = (await secondRes.json()) as { item: { id: number } };

    const duplicateRes = await authReq(`/api/admin/providers/${second.item.id}/identities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId, externalUserId: "shared-wa-id" }),
    });
    expect(duplicateRes.status).toBe(409);
  });
});
