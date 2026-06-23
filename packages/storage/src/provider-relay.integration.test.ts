import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { applyAllMigrations, createIsolatedDb, tryConnectToPg } from "./integration-helpers.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_provider_relay_${Math.random().toString(36).slice(2, 10)}`;
const appRoleName = `app_provider_relay_${Math.random().toString(36).slice(2, 8)}`;
const appRolePass = "test-pass-provider-relay";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const nowEpoch = Math.floor(Date.now() / 1000);

let ownerSql: Sql | null = null;
let appSql: Sql | null = null;
let tenantAId = 0;
let tenantBId = 0;
let tenantAContactId = 0;
let tenantBContactId = 0;

const relayTables = [
  "provider_profiles",
  "provider_services",
  "service_orders",
  "provider_requests",
  "order_events",
] as const;

async function withTenant<T>(
  tenantId: number,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!appSql) throw new Error("appSql not initialized");
  return appSql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.tenant_id = ${tenantId}`);
    return fn(tx);
  }) as unknown as Promise<T>;
}

async function relayCounts(sql: Sql | postgres.TransactionSql): Promise<Record<string, number>> {
  const rows = await sql<Array<{ table_name: string; count: number }>>`
    SELECT 'provider_profiles' AS table_name, COUNT(*)::int AS count FROM provider_profiles
    UNION ALL
    SELECT 'provider_services', COUNT(*)::int FROM provider_services
    UNION ALL
    SELECT 'service_orders', COUNT(*)::int FROM service_orders
    UNION ALL
    SELECT 'provider_requests', COUNT(*)::int FROM provider_requests
    UNION ALL
    SELECT 'order_events', COUNT(*)::int FROM order_events
  `;
  return Object.fromEntries(rows.map((row) => [row.table_name, row.count]));
}

async function seedTenantRelayGraph(opts: {
  tenantId: number;
  customerName: string;
  providerName: string;
}): Promise<{ customerContactId: number; providerContactId: number }> {
  if (!ownerSql) throw new Error("ownerSql not initialized");

  const [customer] = await ownerSql<Array<{ id: number }>>`
    INSERT INTO contacts (tenant_id, display_name, created_at, updated_at)
    VALUES (${opts.tenantId}, ${opts.customerName}, ${nowEpoch}, ${nowEpoch})
    RETURNING id
  `;
  const [providerContact] = await ownerSql<Array<{ id: number }>>`
    INSERT INTO contacts (tenant_id, display_name, created_at, updated_at)
    VALUES (${opts.tenantId}, ${opts.providerName}, ${nowEpoch}, ${nowEpoch})
    RETURNING id
  `;
  if (!customer || !providerContact) throw new Error("contact seed failed");

  const [provider] = await ownerSql<Array<{ id: number }>>`
    INSERT INTO provider_profiles (
      tenant_id, contact_id, name, category, status, service_area, default_commission_pct
    )
    VALUES (
      ${opts.tenantId}, ${providerContact.id}, ${opts.providerName}, 'massage',
      'active', 'Chaweng', 15
    )
    RETURNING id
  `;
  if (!provider) throw new Error("provider profile seed failed");

  await ownerSql`
    INSERT INTO provider_services (
      tenant_id, provider_id, service_type, name, service_area, pricing_policy_json
    )
    VALUES (
      ${opts.tenantId}, ${provider.id}, 'massage', 'Thai massage',
      'Chaweng', '{"basePrice":1200}'
    )
  `;

  const [order] = await ownerSql<Array<{ id: number }>>`
    INSERT INTO service_orders (
      tenant_id, customer_contact_id, assigned_provider_id, request_type, status,
      summary, quoted_amount, customer_amount, commission_pct, commission_amount,
      currency, idempotency_key
    )
    VALUES (
      ${opts.tenantId}, ${customer.id}, ${provider.id}, 'massage', 'awaiting_provider',
      'Massage today around 18:00', 1200, 1380, 15, 180, 'THB',
      ${`order-${opts.tenantId}`}
    )
    RETURNING id
  `;
  if (!order) throw new Error("service order seed failed");

  const [request] = await ownerSql<Array<{ id: number }>>`
    INSERT INTO provider_requests (
      tenant_id, order_id, provider_id, status, quoted_amount, customer_amount,
      commission_amount, currency, response_text, idempotency_key
    )
    VALUES (
      ${opts.tenantId}, ${order.id}, ${provider.id}, 'quoted', 1200, 1380,
      180, 'THB', 'Available at 18:00', ${`provider-request-${opts.tenantId}`}
    )
    RETURNING id
  `;
  if (!request) throw new Error("provider request seed failed");

  await ownerSql`
    INSERT INTO order_events (
      tenant_id, order_id, provider_request_id, actor_type, event_type, data_json
    )
    VALUES (
      ${opts.tenantId}, ${order.id}, ${request.id}, 'provider',
      'provider_quoted', '{"quotedAmount":1200}'
    )
  `;

  return {
    customerContactId: customer.id,
    providerContactId: providerContact.id,
  };
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});

  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  ownerSql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(ownerSql, migrationsDir);

  await ownerSql.unsafe(`
      CREATE ROLE "${appRoleName}" LOGIN PASSWORD '${appRolePass}' NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO "${appRoleName}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${appRoleName}";
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appRoleName}";
    `);

  const tenants = await ownerSql<Array<{ id: number }>>`
      INSERT INTO tenants (slug, plan, status, llm_billing_mode, created_at, updated_at)
      VALUES
        ('provider-relay-alpha', 'free', 'active', 'byok', ${nowEpoch}, ${nowEpoch}),
        ('provider-relay-beta',  'free', 'active', 'byok', ${nowEpoch}, ${nowEpoch})
      RETURNING id
    `;
  if (tenants.length !== 2) throw new Error("tenant seed failed");
  const tenantA = tenants[0];
  const tenantB = tenants[1];
  if (!tenantA || !tenantB) throw new Error("tenant seed returned missing rows");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const seededA = await seedTenantRelayGraph({
    tenantId: tenantAId,
    customerName: "Alice Customer",
    providerName: "Alpha Massage",
  });
  const seededB = await seedTenantRelayGraph({
    tenantId: tenantBId,
    customerName: "Bob Customer",
    providerName: "Beta Massage",
  });
  tenantAContactId = seededA.customerContactId;
  tenantBContactId = seededB.customerContactId;

  const parsed = new URL(testUrl);
  parsed.username = appRoleName;
  parsed.password = appRolePass;
  appSql = postgres(parsed.toString(), { max: 4, onnotice: () => {} });

  const roleInfo = await appSql<Array<{ bypass: boolean; sup: boolean }>>`
      SELECT rolbypassrls as bypass, rolsuper as sup FROM pg_roles WHERE rolname = current_user
    `;
  if (roleInfo[0]?.bypass || roleInfo[0]?.sup) {
    throw new Error("test setup: app role unexpectedly bypasses RLS");
  }
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

describe("provider relay schema", () => {
  it("enables FORCE RLS and tenant_isolation policies on all relay tables", async () => {
    if (!ownerSql) return;
    const rows = await ownerSql<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relkind = 'r'
        AND relname = ANY(${relayTables})
    `;
    expect(rows).toHaveLength(relayTables.length);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    const policies = await ownerSql<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname = 'tenant_isolation'
        AND tablename = ANY(${relayTables})
    `;
    expect(new Set(policies.map((row) => row.tablename))).toEqual(new Set(relayTables));
  });

  it("returns no relay rows without app.tenant_id", async () => {
    if (!appSql) return;
    expect(await relayCounts(appSql)).toEqual({
      provider_profiles: 0,
      provider_services: 0,
      service_orders: 0,
      provider_requests: 0,
      order_events: 0,
    });
  });

  it("scopes provider relay graph by tenant context", async () => {
    if (!appSql) return;
    const tenantACounts = await withTenant(tenantAId, (tx) => relayCounts(tx));
    const tenantBCounts = await withTenant(tenantBId, (tx) => relayCounts(tx));

    expect(tenantACounts).toEqual({
      provider_profiles: 1,
      provider_services: 1,
      service_orders: 1,
      provider_requests: 1,
      order_events: 1,
    });
    expect(tenantBCounts).toEqual(tenantACounts);

    const tenantAOrders = await withTenant(tenantAId, async (tx) => {
      return tx<Array<{ tenant_id: number; customer_contact_id: number }>>`
        SELECT tenant_id, customer_contact_id FROM service_orders
      `;
    });
    expect(tenantAOrders.map((row) => ({ ...row }))).toEqual([
      { tenant_id: tenantAId, customer_contact_id: tenantAContactId },
    ]);
  });

  it("blocks cross-tenant relay inserts through WITH CHECK", async () => {
    if (!appSql) return;
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx`
          INSERT INTO service_orders (
            tenant_id, customer_contact_id, request_type, status, summary
          )
          VALUES (
            ${tenantBId}, ${tenantBContactId}, 'massage', 'intake',
            'cross tenant insert attempt'
          )
        `;
      }),
    ).rejects.toThrow(/row-level security|foreign key/i);

    const tenantBCounts = await withTenant(tenantBId, (tx) => relayCounts(tx));
    expect(tenantBCounts.service_orders).toBe(1);
  });
});
