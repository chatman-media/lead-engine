import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import {
  canTransitionProviderRequest,
  canTransitionServiceOrder,
  ProviderRelayRepo,
} from "./provider-relay.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_provider_relay_dal_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "storage",
  "migrations",
);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let tenantId = 0;
let otherTenantId = 0;
let customerContactId = 0;
let otherCustomerContactId = 0;
let providerContactId = 0;
let providerId = 0;
let now = 0;

const relayRepo = () => new ProviderRelayRepo({ db, tenantId });
const otherRelayRepo = () => new ProviderRelayRepo({ db, tenantId: otherTenantId });

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});

  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), {
    max: 3,
    onnotice: () => {},
  });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;
  now = Math.floor(Date.parse("2026-06-09T00:00:00Z") / 1000);

  const [tenant] = await db
    .insert(schema.tenants)
    .values({ slug: `provider-relay-dal-${now}`, status: "active" })
    .returning({ id: schema.tenants.id });
  const [other] = await db
    .insert(schema.tenants)
    .values({ slug: `provider-relay-dal-other-${now}`, status: "active" })
    .returning({ id: schema.tenants.id });
  if (!tenant || !other) throw new Error("tenant inserts returned no rows");
  tenantId = tenant.id;
  otherTenantId = other.id;

  const [customer] = await db
    .insert(schema.contacts)
    .values({
      tenantId,
      displayName: "Customer",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.contacts.id });
  const [otherCustomer] = await db
    .insert(schema.contacts)
    .values({
      tenantId: otherTenantId,
      displayName: "Other customer",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.contacts.id });
  const [providerContact] = await db
    .insert(schema.contacts)
    .values({
      tenantId,
      displayName: "Provider contact",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.contacts.id });
  if (!customer || !otherCustomer || !providerContact) {
    throw new Error("contact inserts returned no rows");
  }
  customerContactId = customer.id;
  otherCustomerContactId = otherCustomer.id;
  providerContactId = providerContact.id;

  const [provider] = await db
    .insert(schema.providerProfiles)
    .values({
      tenantId,
      contactId: providerContactId,
      name: "Alpha Massage",
      category: "massage",
      status: "active",
      serviceArea: "Chaweng",
      defaultCommissionPct: 15,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.providerProfiles.id });
  if (!provider) throw new Error("provider insert returned no row");
  providerId = provider.id;
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("provider relay lifecycle helpers", () => {
  it("validates service order and provider request transition graph", () => {
    expect(canTransitionServiceOrder("intake", "awaiting_provider")).toBe(true);
    expect(canTransitionServiceOrder("fulfilled", "matching")).toBe(false);
    expect(canTransitionProviderRequest("sent", "quoted")).toBe(true);
    expect(canTransitionProviderRequest("declined", "sent")).toBe(false);
  });
});

describe("ProviderRelayRepo", () => {
  it("creates service orders idempotently and scopes active lookups by tenant", async () => {
    if (!enabled) return;
    const first = await relayRepo().createServiceOrder({
      customerContactId,
      requestType: "massage",
      summary: "Massage today around 18:00",
      idempotencyKey: "order-idem-1",
      nowEpoch: now,
    });
    const duplicate = await relayRepo().createServiceOrder({
      customerContactId,
      requestType: "massage",
      summary: "Duplicate should not overwrite",
      idempotencyKey: "order-idem-1",
      nowEpoch: now + 1,
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.summary).toBe(first.summary);

    await relayRepo().createServiceOrder({
      customerContactId,
      requestType: "massage",
      status: "fulfilled",
      summary: "Historical order",
      nowEpoch: now + 2,
    });

    const active = await relayRepo().findActiveOrdersByCustomer(customerContactId);
    expect(active.map((order) => order.id)).toEqual([first.id]);
    expect(await otherRelayRepo().orderById(first.id)).toBeNull();
    expect(await otherRelayRepo().findActiveOrdersByCustomer(otherCustomerContactId)).toEqual([]);
  });

  it("adds provider requests idempotently and records lifecycle events", async () => {
    if (!enabled) return;
    const order = await relayRepo().createServiceOrder({
      customerContactId,
      requestType: "massage",
      status: "matching",
      nowEpoch: now + 10,
    });

    const request = await relayRepo().addProviderRequest({
      orderId: order.id,
      providerId,
      status: "draft",
      idempotencyKey: "provider-request-idem-1",
      nowEpoch: now + 11,
    });
    const duplicate = await relayRepo().addProviderRequest({
      orderId: order.id,
      providerId,
      idempotencyKey: "provider-request-idem-1",
      nowEpoch: now + 12,
    });

    expect(duplicate.id).toBe(request.id);
    expect((await relayRepo().orderById(order.id))?.status).toBe("awaiting_provider");
    const events = await relayRepo().eventsForOrder(order.id);
    expect(events.map((event) => event.eventType)).toEqual(["provider_request_created"]);
  });

  it("records provider quote, updates the order, and rejects invalid back transitions", async () => {
    if (!enabled) return;
    const order = await relayRepo().createServiceOrder({
      customerContactId,
      requestType: "massage",
      status: "matching",
      nowEpoch: now + 20,
    });
    const request = await relayRepo().addProviderRequest({
      orderId: order.id,
      providerId,
      status: "draft",
      nowEpoch: now + 21,
    });
    await relayRepo().transitionProviderRequestStatus(request.id, "sent", now + 22);

    const quoted = await relayRepo().recordProviderQuote({
      providerRequestId: request.id,
      quotedAmount: 1200,
      customerAmount: 1380,
      commissionAmount: 180,
      responseText: "Available at 18:00",
      nowEpoch: now + 23,
    });
    const updatedOrder = await relayRepo().orderById(order.id);
    const events = await relayRepo().eventsForOrder(order.id);

    expect(quoted.status).toBe("quoted");
    expect(updatedOrder?.status).toBe("offer_ready");
    expect(updatedOrder?.assignedProviderId).toBe(providerId);
    expect(updatedOrder?.customerAmount).toBe(1380);
    expect(events.map((event) => event.eventType)).toEqual([
      "provider_quoted",
      "provider_request_created",
    ]);
    await expect(
      relayRepo().transitionProviderRequestStatus(request.id, "sent", now + 24),
    ).rejects.toThrow(/invalid provider request transition/);
  });

  it("records provider decline and moves the order back to provider_declined", async () => {
    if (!enabled) return;
    const order = await relayRepo().createServiceOrder({
      customerContactId,
      requestType: "massage",
      status: "matching",
      nowEpoch: now + 30,
    });
    const request = await relayRepo().addProviderRequest({
      orderId: order.id,
      providerId,
      status: "sent",
      nowEpoch: now + 31,
    });

    const declined = await relayRepo().recordProviderDecline({
      providerRequestId: request.id,
      responseText: "No slots today",
      nowEpoch: now + 32,
    });
    const updatedOrder = await relayRepo().orderById(order.id);
    const events = await relayRepo().eventsForOrder(order.id);

    expect(declined.status).toBe("declined");
    expect(updatedOrder?.status).toBe("provider_declined");
    expect(events.map((event) => event.eventType)).toEqual([
      "provider_declined",
      "provider_request_created",
    ]);
  });

  it("expires stale provider requests and records an event", async () => {
    if (!enabled) return;
    const order = await relayRepo().createServiceOrder({
      customerContactId,
      requestType: "massage",
      status: "matching",
      nowEpoch: now + 40,
    });
    const request = await relayRepo().addProviderRequest({
      orderId: order.id,
      providerId,
      status: "sent",
      quoteExpiresAt: now + 45,
      nowEpoch: now + 41,
    });

    const expired = await relayRepo().expireProviderRequest({
      providerRequestId: request.id,
      nowEpoch: now + 46,
    });
    const updatedOrder = await relayRepo().orderById(order.id);
    const events = await relayRepo().eventsForOrder(order.id);

    expect(expired.status).toBe("expired");
    expect(expired.expiredAt).toBe(now + 46);
    expect(updatedOrder?.status).toBe("provider_declined");
    expect(events.map((event) => event.eventType)).toEqual([
      "provider_request_expired",
      "provider_request_created",
    ]);
  });
});
