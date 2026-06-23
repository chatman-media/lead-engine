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
import { ProviderRelayOrchestrator } from "./provider-relay-orchestrator.ts";
import { ProviderResponseHandler } from "./provider-response-handler.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_customer_offer_${Math.random().toString(36).slice(2, 10)}`;
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

const customerExternalUserId = "tg-customer-1";
const providerExternalUserId = "wa-provider-1";

const flow = () => new CustomerOfferFlow({ db, tenantId });
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

async function createProvider(): Promise<number> {
  const [provider] = await db
    .insert(schema.providerProfiles)
    .values({
      tenantId,
      contactId: providerContactId,
      name: "Customer Offer Massage",
      category: "massage",
      status: "active",
      serviceArea: "Chaweng",
      defaultCommissionPct: 15,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.providerProfiles.id });
  if (!provider) throw new Error("provider insert returned no row");

  await db.insert(schema.providerServices).values({
    tenantId,
    providerId: provider.id,
    serviceType: "massage",
    name: "Massage service",
    serviceArea: "Chaweng",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  return provider.id;
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

async function startQuotedOrder(label: string, at: number) {
  const outreach = await orchestrator().startProviderOutreach({
    customerContactId,
    requestType: "massage",
    serviceArea: "Chaweng",
    summary: `${label} massage today around 18:00`,
    customerConversationId: null,
    orderIdempotencyKey: `offer-order-${label}`,
    providerRequestIdempotencyKey: `offer-provider-request-${label}`,
    outboundIdempotencyKey: `offer-provider-outbound-${label}`,
    nowEpoch: at,
  });
  expect(outreach.ok).toBe(true);
  if (!outreach.ok) throw new Error("expected provider outreach success");

  const quote = await responseHandler().handleProviderResponse({
    inbound: providerInbound("Available today 18:00, price 1,200 THB", `wa-quote-${label}`, at + 1),
  });
  expect(quote.ok).toBe(true);
  if (!quote.ok) throw new Error("expected provider quote success");
  expect(quote.action).toBe("quoted");
  return quote;
}

async function tableCount(tableName: string): Promise<number> {
  if (!sql) throw new Error("sql not initialized");
  const rows = await sql.unsafe<Array<{ count: number }>>(
    `SELECT COUNT(*)::int AS count FROM ${tableName} WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0]?.count ?? 0;
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
  now = Math.floor(Date.parse("2026-06-09T04:00:00Z") / 1000);

  const [tenant] = await db
    .insert(schema.tenants)
    .values({ slug: `customer-offer-${now}`, status: "active" })
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

  customerContactId = await createContact("Customer offer contact");
  providerContactId = await createContact("Provider offer contact");
  telegramChannelId = await createChannel("telegram_bot", "bot-offer");
  whatsappChannelId = await createChannel("whatsapp", "wa-offer");
  providerId = await createProvider();

  await db.insert(schema.channelIdentities).values([
    {
      contactId: customerContactId,
      channelId: telegramChannelId,
      externalUserId: customerExternalUserId,
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

describe("CustomerOfferFlow", () => {
  it("runs Telegram customer to WhatsApp provider to Telegram customer e2e with fake adapters", async () => {
    if (!enabled) return;
    const [conversation] = await db
      .insert(schema.conversations)
      .values({
        tenantId,
        userId: customerContactId,
        source: "bot",
        channelId: telegramChannelId,
        mode: "ai",
        status: "open",
        lastMessageAt: now + 5,
        createdAt: now + 5,
      })
      .returning({ id: schema.conversations.id });
    if (!conversation) throw new Error("conversation insert returned no row");
    await db.insert(schema.messages).values({
      tenantId,
      conversationId: conversation.id,
      role: "user",
      text: "Need in-room massage in Chaweng today 18:00",
      createdAt: now + 5,
    });

    const outboundBefore = await tableCount("outbound_queue");
    const outreach = await orchestrator().startProviderOutreach({
      customerContactId,
      customerConversationId: conversation.id,
      requestType: "massage",
      serviceArea: "Chaweng",
      summary: "Telegram customer asks for in-room massage today 18:00",
      preferredChannelKinds: ["whatsapp"],
      orderIdempotencyKey: "e2e-order-telegram-whatsapp",
      providerRequestIdempotencyKey: "e2e-provider-request-whatsapp",
      outboundIdempotencyKey: "e2e-provider-outbound-whatsapp",
      nowEpoch: now + 110,
    });

    expect(outreach.ok).toBe(true);
    if (!outreach.ok) throw new Error("expected outreach success");
    expect(outreach.identity).toMatchObject({
      channelDbId: whatsappChannelId,
      channelKind: "whatsapp",
      externalUserId: providerExternalUserId,
    });
    expect(outreach.outbound.channelId).toBe(whatsappChannelId);
    expect(await tableCount("outbound_queue")).toBe(outboundBefore + 1);
    const providerPayload = JSON.parse(outreach.outbound.payloadJson);
    expect(providerPayload.externalUserId).toBe(providerExternalUserId);
    expect(providerPayload.parts[0].text).toContain("New massage request");
    expect(providerPayload.parts[0].text).toContain("Area: Chaweng");

    const quote = await responseHandler().handleProviderResponse({
      inbound: providerInbound("Available today 18:00, price 1,200 THB", "wa-e2e-quote", now + 120),
    });
    expect(quote.ok).toBe(true);
    if (!quote.ok) throw new Error("expected provider quote success");
    expect(quote.order).toMatchObject({
      id: outreach.order.id,
      status: "offer_ready",
      customerConversationId: conversation.id,
      assignedProviderId: providerId,
      customerAmount: 1380,
    });

    const customerOffer = await flow().sendCustomerOffer({
      orderId: outreach.order.id,
      customerChannelId: telegramChannelId,
      nowEpoch: now + 130,
    });
    expect(customerOffer.ok).toBe(true);
    if (!customerOffer.ok) throw new Error("expected customer offer success");
    expect(customerOffer.identity).toMatchObject({
      channelDbId: telegramChannelId,
      channelKind: "telegram_bot",
      externalUserId: customerExternalUserId,
    });
    expect(customerOffer.outbound.channelId).toBe(telegramChannelId);
    expect(customerOffer.outbound.conversationId).toBe(conversation.id);
    const customerPayload = JSON.parse(customerOffer.outbound.payloadJson);
    expect(customerPayload.externalUserId).toBe(customerExternalUserId);
    expect(customerPayload.parts[0].text).toContain("Провайдер подтвердил");
    expect(customerPayload.parts[0].text).toContain("Стоимость: 1,380 THB");
    expect(await tableCount("outbound_queue")).toBe(outboundBefore + 2);

    const events = await relayRepo().eventsForOrder(outreach.order.id);
    expect(new Set(events.map((event) => event.eventType))).toEqual(
      new Set([
        "provider_request_created",
        "provider_request_sent",
        "provider_quoted",
        "customer_offer_sent",
      ]),
    );
  });

  it("sends a normalized provider offer to the customer channel idempotently", async () => {
    if (!enabled) return;
    const quote = await startQuotedOrder("send", now + 10);
    const outboundBefore = await tableCount("outbound_queue");

    const first = await flow().sendCustomerOffer({
      orderId: quote.order.id,
      customerChannelId: telegramChannelId,
      nowEpoch: now + 20,
    });
    const second = await flow().sendCustomerOffer({
      orderId: quote.order.id,
      customerChannelId: telegramChannelId,
      nowEpoch: now + 21,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected customer offer");
    expect(first.outbound.id).toBe(second.outbound.id);
    expect(first.identity).toMatchObject({
      channelDbId: telegramChannelId,
      externalUserId: customerExternalUserId,
    });
    expect(await tableCount("outbound_queue")).toBe(outboundBefore + 1);

    const payload = JSON.parse(first.outbound.payloadJson);
    expect(payload.externalUserId).toBe(customerExternalUserId);
    expect(payload.parts[0].text).toContain("Провайдер подтвердил");
    expect(payload.parts[0].text).toContain("Район: Chaweng");
    expect(payload.parts[0].text).toContain("Время: today 18:00");
    expect(payload.parts[0].text).toContain("Стоимость: 1,380 THB");

    const events = await relayRepo().eventsForOrder(quote.order.id);
    const sentEvents = events.filter((event) => event.eventType === "customer_offer_sent");
    expect(sentEvents).toHaveLength(1);
    expect(JSON.parse(sentEvents[0]?.dataJson ?? "{}")).toMatchObject({
      channelId: telegramChannelId,
      channelKind: "telegram_bot",
      manualOverride: false,
      customerAmount: 1380,
      currency: "THB",
      serviceArea: "Chaweng",
      availabilityText: "today 18:00",
    });
  });

  it("allows an operator to edit the offer text before enqueueing it", async () => {
    if (!enabled) return;
    const quote = await startQuotedOrder("manual", now + 30);

    const result = await flow().sendCustomerOffer({
      orderId: quote.order.id,
      customerChannelId: telegramChannelId,
      offerTextOverride: "Custom operator-approved offer",
      approvedByAdminId: 77,
      nowEpoch: now + 40,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected manual customer offer");
    const payload = JSON.parse(result.outbound.payloadJson);
    expect(payload.parts[0].text).toBe("Custom operator-approved offer");

    const events = await relayRepo().eventsForOrder(quote.order.id);
    const event = events.find((orderEvent) => orderEvent.eventType === "customer_offer_sent");
    expect(event?.actorType).toBe("operator");
    expect(JSON.parse(event?.dataJson ?? "{}")).toMatchObject({
      manualOverride: true,
      approvedByAdminId: 77,
      offerText: "Custom operator-approved offer",
    });
  });

  it("moves customer acceptance to awaiting payment and records provider request acceptance", async () => {
    if (!enabled) return;
    const quote = await startQuotedOrder("accept", now + 50);

    const accepted = await flow().acceptCustomerOffer({
      orderId: quote.order.id,
      acceptedByContactId: customerContactId,
      nowEpoch: now + 60,
    });

    expect(accepted.order).toMatchObject({
      id: quote.order.id,
      status: "awaiting_customer_payment",
      paymentStatus: "pending",
    });
    expect(accepted.providerRequest).toMatchObject({
      status: "accepted",
    });

    const events = await relayRepo().eventsForOrder(quote.order.id);
    expect(events.map((event) => event.eventType)).toContain("customer_offer_accepted");
  });

  it("records payment success, confirms the order, and sends provider confirmation", async () => {
    if (!enabled) return;
    const quote = await startQuotedOrder("pay", now + 70);
    await flow().acceptCustomerOffer({
      orderId: quote.order.id,
      acceptedByContactId: customerContactId,
      nowEpoch: now + 80,
    });
    const outboundBefore = await tableCount("outbound_queue");

    const paid = await flow().recordPaymentSuccess({
      orderId: quote.order.id,
      paymentProvider: "manual",
      paymentRef: "pay_123",
      nowEpoch: now + 90,
    });

    expect(paid.ok).toBe(true);
    if (!paid.ok) throw new Error("expected payment success");
    expect(paid.order).toMatchObject({
      id: quote.order.id,
      status: "confirmed",
      paymentStatus: "paid",
      paymentProvider: "manual",
      paymentRef: "pay_123",
    });
    expect(paid.identity).toMatchObject({
      channelDbId: whatsappChannelId,
      externalUserId: providerExternalUserId,
    });
    expect(paid.outbound?.channelId).toBe(whatsappChannelId);
    expect(await tableCount("outbound_queue")).toBe(outboundBefore + 1);

    const payload = JSON.parse(paid.outbound?.payloadJson ?? "{}");
    expect(payload.externalUserId).toBe(providerExternalUserId);
    expect(payload.parts[0].text).toContain("Customer confirmed and paid");
    expect(payload.parts[0].text).toContain(`order #${quote.order.id}`);

    const events = await relayRepo().eventsForOrder(quote.order.id);
    expect(new Set(events.map((event) => event.eventType))).toEqual(
      new Set([
        "provider_confirmation_sent",
        "service_order_confirmed",
        "customer_payment_succeeded",
        "commission_earned",
        "payment_intent_created",
        "customer_offer_accepted",
        "provider_quoted",
        "provider_request_sent",
        "provider_request_created",
      ]),
    );
    expect(paid.providerRequest.providerId).toBe(providerId);
  });

  it("builds customer order context for reply strategy grounding", async () => {
    if (!enabled) return;
    const quote = await startQuotedOrder("context", now + 100);

    const context = await flow().buildCustomerOrderContext(customerContactId);

    expect(context).toContain("BROKERED ORDER CONTEXT");
    expect(context).toContain(`order #${quote.order.id}`);
    expect(context).toContain("service=massage");
    expect(context).toContain("status=offer_ready");
    expect(context).toContain("area=Chaweng");
    expect(context).toContain("amount=1,380 THB");
    expect(context).toContain("payment=unpaid");
  });

  it("contact with several identities resolves the most preferred channel kind", async () => {
    if (!enabled) return;
    const multiContactId = await createContact("Multi identity customer");
    await db.insert(schema.channelIdentities).values([
      {
        contactId: multiContactId,
        channelId: whatsappChannelId,
        externalUserId: "wa-multi-cust",
        createdAt: now,
      },
      {
        contactId: multiContactId,
        channelId: telegramChannelId,
        externalUserId: "tg-multi-cust",
        createdAt: now,
      },
    ]);

    // Приватный резолвер — единственное место, где сортировка по
    // preferredKinds сравнивает >1 кандидата.
    const resolver = flow() as unknown as {
      resolveContactChannelIdentity(opts: {
        contactId: number;
        preferredKinds: string[];
      }): Promise<{ channelKind: string; externalUserId: string } | null>;
    };
    const identity = await resolver.resolveContactChannelIdentity({
      contactId: multiContactId,
      preferredKinds: ["telegram_bot", "whatsapp"],
    });

    expect(identity?.channelKind).toBe("telegram_bot");
    expect(identity?.externalUserId).toBe("tg-multi-cust");
  });

  it("provider with several identities resolves WhatsApp first", async () => {
    if (!enabled) return;
    const multiProviderContactId = await createContact("Multi identity provider");
    const [provider] = await db
      .insert(schema.providerProfiles)
      .values({
        tenantId,
        contactId: multiProviderContactId,
        name: "Multi Channel Provider",
        category: "massage",
        status: "active",
        defaultCommissionPct: 10,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.providerProfiles.id });
    if (!provider) throw new Error("provider insert returned no row");
    await db.insert(schema.channelIdentities).values([
      {
        contactId: multiProviderContactId,
        channelId: telegramChannelId,
        externalUserId: "tg-multi-prov",
        createdAt: now,
      },
      {
        contactId: multiProviderContactId,
        channelId: whatsappChannelId,
        externalUserId: "wa-multi-prov",
        createdAt: now,
      },
    ]);

    const resolver = flow() as unknown as {
      resolveProviderChannelIdentity(opts: {
        providerRequest: {
          providerId: number | null;
          channelId: number | null;
        };
      }): Promise<{ channelKind: string; externalUserId: string } | null>;
    };
    // channelId=null → выборка не сужается до одного канала и сортировка
    // по defaultProviderChannelKinds реально сравнивает кандидатов.
    const identity = await resolver.resolveProviderChannelIdentity({
      providerRequest: { providerId: provider.id, channelId: null },
    });

    expect(identity?.channelKind).toBe("whatsapp");
    expect(identity?.externalUserId).toBe("wa-multi-prov");

    // providerId=null → ранний выход.
    expect(
      await resolver.resolveProviderChannelIdentity({
        providerRequest: { providerId: null, channelId: null },
      }),
    ).toBeNull();
  });
});
