import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Inbound } from "@chatman-media/channel-core";
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
import { CustomerOfferFlow } from "./customer-offer-flow.ts";
import { ProviderRelayRepo } from "./dal/provider-relay.ts";
import { ProviderPaymentLedger } from "./provider-payment-ledger.ts";
import { ProviderRelayOrchestrator } from "./provider-relay-orchestrator.ts";
import { ProviderResponseHandler } from "./provider-response-handler.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_provider_payment_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "storage",
  "migrations",
);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let tenantId = 0;
let customerContactId = 0;
let providerContactId = 0;
let providerId = 0;
let telegramChannelId = 0;
let whatsappChannelId = 0;
let now = 0;

const providerExternalUserId = "wa-payment-provider";

const flow = () => new CustomerOfferFlow({ db, tenantId });
const ledger = () => new ProviderPaymentLedger({ db, tenantId });
const orchestrator = () => new ProviderRelayOrchestrator({ db, tenantId });
const responseHandler = () => new ProviderResponseHandler({ db, tenantId });
const relayRepo = () => new ProviderRelayRepo({ db, tenantId });

async function createContact(displayName: string): Promise<number> {
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      tenantId,
      displayName,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.contacts.id });
  if (!contact) throw new Error("contact insert returned no row");
  return contact.id;
}

async function createChannel(kind: "telegram_bot" | "whatsapp", externalId: string) {
  const [channel] = await db
    .insert(schema.channels)
    .values({
      tenantId,
      kind,
      externalId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.channels.id });
  if (!channel) throw new Error("channel insert returned no row");
  return channel.id;
}

function providerInbound(text: string, externalMessageId: string, at: number): Inbound {
  return {
    channelId: String(whatsappChannelId),
    externalMessageId,
    externalUserId: providerExternalUserId,
    parts: [{ kind: "text", text }],
    receivedAt: at,
    raw: { test: true },
  };
}

async function startAcceptedOrder(label: string, at: number) {
  const outreach = await orchestrator().startProviderOutreach({
    customerContactId,
    requestType: "massage",
    serviceArea: "Chaweng",
    summary: `${label} massage today around 18:00`,
    orderIdempotencyKey: `payment-order-${label}`,
    providerRequestIdempotencyKey: `payment-provider-request-${label}`,
    outboundIdempotencyKey: `payment-provider-outbound-${label}`,
    nowEpoch: at,
  });
  expect(outreach.ok).toBe(true);
  if (!outreach.ok) throw new Error("expected provider outreach success");

  const quote = await responseHandler().handleProviderResponse({
    inbound: providerInbound(
      "Available today 18:00, price 1,200 THB",
      `wa-payment-quote-${label}`,
      at + 1,
    ),
  });
  expect(quote.ok).toBe(true);
  if (!quote.ok) throw new Error("expected provider quote success");
  expect(quote.order).toMatchObject({
    quotedAmount: 1200,
    customerAmount: 1380,
    commissionPct: 15,
    commissionAmount: 180,
  });

  const accepted = await flow().acceptCustomerOffer({
    orderId: quote.order.id,
    acceptedByContactId: customerContactId,
    nowEpoch: at + 2,
  });
  expect(accepted.order.status).toBe("awaiting_customer_payment");
  return accepted.order;
}

async function eventsForOrder(orderId: number): Promise<string[]> {
  return (await relayRepo().eventsForOrder(orderId)).map((event) => event.eventType);
}

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
  now = Math.floor(Date.parse("2026-06-09T05:00:00Z") / 1000);

  const [tenant] = await db
    .insert(schema.tenants)
    .values({ slug: `provider-payment-${now}`, status: "active" })
    .returning({ id: schema.tenants.id });
  if (!tenant) throw new Error("tenant insert returned no row");
  tenantId = tenant.id;
  await db.insert(schema.tenantFeatureFlags).values({
    tenantId,
    featureKey: "provider_relay",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });

  customerContactId = await createContact("Payment customer");
  providerContactId = await createContact("Payment provider");
  telegramChannelId = await createChannel("telegram_bot", "bot-payment");
  whatsappChannelId = await createChannel("whatsapp", "wa-payment");

  const [provider] = await db
    .insert(schema.providerProfiles)
    .values({
      tenantId,
      contactId: providerContactId,
      name: "Payment Massage",
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

  await db.insert(schema.providerServices).values({
    tenantId,
    providerId,
    serviceType: "massage",
    name: "Massage service",
    serviceArea: "Chaweng",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.channelIdentities).values([
    {
      contactId: customerContactId,
      channelId: telegramChannelId,
      externalUserId: "tg-payment-customer",
      createdAt: now,
    },
    {
      contactId: providerContactId,
      channelId: whatsappChannelId,
      externalUserId: providerExternalUserId,
      createdAt: now,
    },
  ]);
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("ProviderPaymentLedger", () => {
  it("enables FORCE RLS and tenant policies on payment ledger tables", async () => {
    if (!enabled || !sql) return;
    const rows = await sql<Array<{ relname: string; relforcerowsecurity: boolean }>>`
			SELECT c.relname, c.relforcerowsecurity
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public'
				AND c.relname IN ('service_order_payments', 'service_order_commissions')
			ORDER BY c.relname
		`;
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { relname: "service_order_commissions", relforcerowsecurity: true },
      { relname: "service_order_payments", relforcerowsecurity: true },
    ]);
    const policies = await sql<Array<{ count: number }>>`
			SELECT COUNT(*)::int AS count
			FROM pg_policies
			WHERE schemaname = 'public'
				AND policyname = 'tenant_isolation'
				AND tablename IN ('service_order_payments', 'service_order_commissions')
		`;
    expect(policies[0]?.count).toBe(2);
  });

  it("creates a payment intent idempotently and links it to service_orders", async () => {
    if (!enabled) return;
    const order = await startAcceptedOrder("intent", now + 10);

    const first = await ledger().createPaymentIntent({
      orderId: order.id,
      provider: "stripe",
      externalIntentId: "pi_intent_1",
      externalSessionId: "cs_intent_1",
      idempotencyKey: "intent-idem-1",
      nowEpoch: now + 20,
    });
    const second = await ledger().createPaymentIntent({
      orderId: order.id,
      provider: "stripe",
      externalIntentId: "pi_intent_1",
      externalSessionId: "cs_intent_1",
      idempotencyKey: "intent-idem-1",
      nowEpoch: now + 21,
    });

    expect(second.payment.id).toBe(first.payment.id);
    expect(first.payment).toMatchObject({
      orderId: order.id,
      provider: "stripe",
      externalIntentId: "pi_intent_1",
      externalSessionId: "cs_intent_1",
      status: "pending",
      amount: 1380,
      currency: "THB",
    });
    expect(first.order).toMatchObject({
      id: order.id,
      status: "awaiting_customer_payment",
      paymentStatus: "pending",
      paymentProvider: "stripe",
      paymentRef: "pi_intent_1",
      customerAmount: 1380,
      commissionPct: 15,
      commissionAmount: 180,
    });
    expect(await eventsForOrder(order.id)).toContain("payment_intent_created");
  });

  it("records successful payment webhook idempotently and earns commission", async () => {
    if (!enabled) return;
    const order = await startAcceptedOrder("success", now + 30);

    const first = await ledger().recordPaymentSucceeded({
      orderId: order.id,
      provider: "stripe",
      externalIntentId: "pi_success_1",
      externalSessionId: "cs_success_1",
      idempotencyKey: "success-idem-1",
      nowEpoch: now + 40,
    });
    const second = await ledger().recordPaymentSucceeded({
      orderId: order.id,
      provider: "stripe",
      externalIntentId: "pi_success_1",
      externalSessionId: "cs_success_1",
      idempotencyKey: "success-idem-1",
      nowEpoch: now + 41,
    });

    expect(second.payment.id).toBe(first.payment.id);
    expect(second.commission?.id).toBe(first.commission?.id);
    expect(first.payment).toMatchObject({
      status: "paid",
      paidAt: now + 40,
    });
    expect(first.order).toMatchObject({
      status: "paid",
      paymentStatus: "paid",
      paymentProvider: "stripe",
      paymentRef: "pi_success_1",
    });
    expect(first.commission).toMatchObject({
      orderId: order.id,
      providerId,
      paymentId: first.payment.id,
      status: "earned",
      grossAmount: 1380,
      commissionPct: 15,
      commissionAmount: 180,
      currency: "THB",
    });

    const events = await eventsForOrder(order.id);
    expect(events.filter((event) => event === "customer_payment_succeeded")).toHaveLength(1);
    expect(events.filter((event) => event === "commission_earned")).toHaveLength(1);
  });

  it("records failed payment webhook and moves the order to failed", async () => {
    if (!enabled) return;
    const order = await startAcceptedOrder("failed", now + 50);

    const failed = await ledger().recordPaymentFailed({
      orderId: order.id,
      provider: "stripe",
      externalIntentId: "pi_failed_1",
      error: "card_declined",
      nowEpoch: now + 60,
    });

    expect(failed.payment).toMatchObject({
      status: "failed",
      failedAt: now + 60,
    });
    expect(failed.order).toMatchObject({
      status: "failed",
      paymentStatus: "failed",
    });
    expect(await eventsForOrder(order.id)).toContain("customer_payment_failed");
  });

  it("refunds paid orders, records final state, and reverses commission", async () => {
    if (!enabled) return;
    const order = await startAcceptedOrder("refund", now + 70);
    const paid = await ledger().recordPaymentSucceeded({
      orderId: order.id,
      provider: "stripe",
      externalIntentId: "pi_refund_1",
      nowEpoch: now + 80,
    });

    const refunded = await ledger().refundPayment({
      paymentId: paid.payment.id,
      reason: "customer_cancelled",
      nowEpoch: now + 90,
    });

    expect(refunded.payment).toMatchObject({
      status: "refunded",
      refundedAt: now + 90,
    });
    expect(refunded.order).toMatchObject({
      status: "cancelled",
      paymentStatus: "refunded",
    });
    expect(refunded.commission).toMatchObject({
      id: paid.commission?.id,
      status: "refunded",
      refundedAt: now + 90,
    });
    const events = await eventsForOrder(order.id);
    expect(events).toContain("customer_payment_refunded");
    expect(events).toContain("commission_refunded");
  });

  it("cancels pending payment intents and records final state", async () => {
    if (!enabled) return;
    const order = await startAcceptedOrder("cancel", now + 100);
    const intent = await ledger().createPaymentIntent({
      orderId: order.id,
      provider: "manual",
      externalIntentId: "manual_cancel_1",
      nowEpoch: now + 110,
    });

    const cancelled = await ledger().cancelPaymentIntent({
      paymentId: intent.payment.id,
      reason: "operator_cancelled",
      nowEpoch: now + 120,
    });

    expect(cancelled.payment).toMatchObject({
      status: "cancelled",
      cancelledAt: now + 120,
    });
    expect(cancelled.order).toMatchObject({
      status: "cancelled",
      paymentStatus: "unpaid",
    });
    expect(await eventsForOrder(order.id)).toContain("customer_payment_cancelled");
  });
});
