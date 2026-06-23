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
import { makeAdminProviderMarketplaceRoutes } from "./admin-provider-marketplace.ts";
import { makeAdminServiceCatalogRoutes } from "./admin-service-catalog.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_provider_marketplace_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-provider-marketplace-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tokenB = "";

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
  app.route("/", makeAdminProviderMarketplaceRoutes({ db }));
  app.route("/", makeAdminServiceCatalogRoutes({ db }));

  tokenA = await signup("marketplace-a@demo.io");
  tokenB = await signup("marketplace-b@demo.io");
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function signup(email: string): Promise<string> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "strong-pwd-12345" }),
  });
  return ((await res.json()) as { token: string }).token;
}

async function authReq(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe("admin provider marketplace", () => {
  it("lists curated providers and installs one idempotently into the service catalog", async () => {
    if (!sql) return;

    const listRes = await authReq(tokenA, "/api/admin/provider-marketplace");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      items: Array<{
        key: string;
        installed: null | { serviceCatalogItemId: number };
      }>;
    };
    expect(list.items.length).toBeGreaterThan(4);
    expect(list.items.find((item) => item.key === "phuket_transfer_network")?.installed).toBeNull();

    const installRes = await authReq(
      tokenA,
      "/api/admin/provider-marketplace/phuket_transfer_network/install",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(installRes.status).toBe(201);
    const installed = (await installRes.json()) as {
      provider: {
        key: string;
        installed: {
          partnerId: number;
          partnerServiceId: number;
          serviceCatalogItemId: number;
          serviceCatalogSlug: string;
        };
      };
      created: boolean;
    };
    expect(installed.created).toBe(true);
    expect(installed.provider.key).toBe("phuket_transfer_network");
    expect(installed.provider.installed.serviceCatalogSlug).toBe("transfer_provider");

    const duplicateRes = await authReq(
      tokenA,
      "/api/admin/provider-marketplace/phuket_transfer_network/install",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(duplicateRes.status).toBe(200);
    const duplicate = (await duplicateRes.json()) as typeof installed;
    expect(duplicate.created).toBe(false);
    expect(duplicate.provider.installed.serviceCatalogItemId).toBe(
      installed.provider.installed.serviceCatalogItemId,
    );
    expect(duplicate.provider.installed.partnerServiceId).toBe(
      installed.provider.installed.partnerServiceId,
    );

    const catalogRes = await authReq(tokenA, "/api/admin/service-catalog");
    const catalog = (await catalogRes.json()) as {
      items: Array<{
        routeType: string;
        partnerServiceId: number | null;
        metadataJson: string;
      }>;
    };
    expect(catalog.items).toHaveLength(1);
    const catalogItem = catalog.items[0];
    expect(catalog.items[0]?.routeType).toBe("partner_service");
    expect(catalog.items[0]?.partnerServiceId).toBe(installed.provider.installed.partnerServiceId);
    expect(catalogItem).toBeDefined();
    expect(JSON.parse(catalogItem?.metadataJson ?? "{}").providerKey).toBe(
      "phuket_transfer_network",
    );

    const tenantBListRes = await authReq(tokenB, "/api/admin/provider-marketplace");
    const tenantBList = (await tenantBListRes.json()) as {
      items: Array<{
        key: string;
        installed: null | { serviceCatalogItemId: number };
      }>;
    };
    expect(
      tenantBList.items.find((item) => item.key === "phuket_transfer_network")?.installed,
    ).toBeNull();
  });

  it("creates custom providers as tenant-owned partner services", async () => {
    if (!sql) return;

    const customRes = await authReq(tokenA, "/api/admin/provider-marketplace/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerName: "Chef Sasha",
        serviceName: "Private dinner",
        category: "Custom offer",
        description: "Меню и депозит подтверждает оператор",
        commissionPct: 9,
        requiredFields: "date,people,address,budget",
      }),
    });
    expect(customRes.status).toBe(201);
    const custom = (await customRes.json()) as {
      provider: {
        installed: {
          partnerName: string;
          serviceName: string;
          serviceCatalogSlug: string;
        };
      };
    };
    expect(custom.provider.installed.partnerName).toBe("Chef Sasha");
    expect(custom.provider.installed.serviceName).toBe("Private dinner");
    expect(custom.provider.installed.serviceCatalogSlug).toBe("private_dinner");

    const listRes = await authReq(tokenA, "/api/admin/provider-marketplace");
    const list = (await listRes.json()) as {
      customProviders: Array<{ serviceName: string }>;
    };
    expect(list.customProviders.some((item) => item.serviceName === "Private dinner")).toBe(true);
  });
});
