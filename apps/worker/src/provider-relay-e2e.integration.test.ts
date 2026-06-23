import type {
  ChannelAdapter,
  ChannelCapabilities,
  DeleteOpts,
  EditOpts,
  Inbound,
  MediaRef,
  OutboundEnvelope,
  Sent,
} from "@chatman-media/channel-core";
import {
  CustomerOfferFlow,
  ProviderRelayOrchestrator,
  ProviderRelayRepo,
  ProviderResponseHandler,
  withTenant,
} from "@chatman-media/conversation-engine";
import { makePlatformMetrics } from "@chatman-media/observability";
import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { WorkerChannelRegistry, type WorkerChannelEntry } from "./channel-registry.ts";
import { OutboundDispatcher } from "./dispatcher.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_provider_relay_e2e_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let customerContactId = 0;
let providerContactId = 0;
let providerId = 0;
let telegramChannelId = 0;
let whatsappChannelId = 0;
const now = Math.floor(Date.parse("2026-06-09T08:00:00Z") / 1000);

class FakeAdapter implements ChannelAdapter {
  readonly capabilities: ChannelCapabilities = {
    text: true,
    photo: false,
    video: false,
    voice: false,
    document: false,
    edit: false,
    delete: false,
    callbackQuery: false,
    typing: false,
  };
  readonly sendCalls: OutboundEnvelope[] = [];

  constructor(
    readonly id: string,
    readonly kind: "telegram_bot" | "whatsapp",
  ) {}

  receive(): AsyncIterable<Inbound> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.resolve({
            value: undefined as unknown as Inbound,
            done: true,
          }),
      }),
    };
  }

  async send(envelope: OutboundEnvelope): Promise<Sent> {
    this.sendCalls.push(envelope);
    return {
      channelId: this.id,
      externalMessageId: `${this.kind}-fake-${this.sendCalls.length}`,
      sentAt: Math.floor(Date.now() / 1000),
    };
  }

  async edit(_opts: EditOpts): Promise<void> {
    throw new Error("not implemented");
  }

  async delete(_opts: DeleteOpts): Promise<void> {
    throw new Error("not implemented");
  }

  async downloadMedia(_ref: MediaRef): Promise<Response> {
    throw new Error("not implemented");
  }

  async signalTyping(_id: string): Promise<void> {
    // no-op
  }
}

class TestRegistry extends WorkerChannelRegistry {
  setEntry(entry: WorkerChannelEntry): void {
    // biome-ignore lint/suspicious/noExplicitAny: тестовый доступ к private map
    (this as any).byDbId.set(entry.channelDbId, entry);
  }
}

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

async function createChannel(
  kind: "telegram_bot" | "whatsapp",
  externalId: string,
): Promise<number> {
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
    externalUserId: "wa-provider-e2e",
    parts: [{ kind: "text", text }],
    receivedAt: at,
    raw: { test: true },
  };
}

async function dispatchOnce(dispatcher: OutboundDispatcher): Promise<void> {
  await (dispatcher as unknown as { tick: () => Promise<void> }).tick();
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);

  const rlsTables = await sql<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname='public' AND rowsecurity=true
    `;
  for (const { tablename } of rlsTables) {
    await sql.unsafe(`ALTER TABLE "${tablename}" NO FORCE ROW LEVEL SECURITY`);
  }
  db = drizzle(sql, { schema });

  const [tenant] = await db
    .insert(tenants)
    .values({
      slug: `provider-relay-e2e-${now}`,
      plan: "free",
      status: "active",
      llmBillingMode: "byok",
    })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("tenant insert returned no row");
  tenantId = tenant.id;

  customerContactId = await createContact("Telegram customer");
  providerContactId = await createContact("WhatsApp provider");
  telegramChannelId = await createChannel("telegram_bot", "provider-relay-bot");
  whatsappChannelId = await createChannel("whatsapp", "phone-number-provider-relay");

  await db.insert(schema.channelIdentities).values([
    {
      contactId: customerContactId,
      channelId: telegramChannelId,
      externalUserId: "tg-customer-e2e",
      createdAt: now,
    },
    {
      contactId: providerContactId,
      channelId: whatsappChannelId,
      externalUserId: "wa-provider-e2e",
      createdAt: now,
    },
  ]);

  const [provider] = await db
    .insert(schema.providerProfiles)
    .values({
      tenantId,
      contactId: providerContactId,
      name: "E2E Massage Provider",
      category: "massage",
      status: "active",
      serviceArea: "Chaweng",
      defaultCommissionPct: 15,
      metadataJson: JSON.stringify({
        whatsappOptIn: {
          source: "admin_import",
          acceptedAt: now - 60,
          categories: ["utility"],
        },
        whatsappProviderRequestTemplate: {
          name: "provider_request_v1",
          languageCode: "en_US",
          category: "utility",
          approved: true,
        },
      }),
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

  await db.insert(schema.tenantFeatureFlags).values({
    tenantId,
    featureKey: "provider_relay",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("provider relay Telegram customer → WhatsApp provider e2e", () => {
  it("dispatches provider outreach, handles quote, sends customer offer, records payment, and exposes metrics", async () => {
    if (!sql) return;
    const metrics = makePlatformMetrics();
    const telegramAdapter = new FakeAdapter(String(telegramChannelId), "telegram_bot");
    const whatsappAdapter = new FakeAdapter(String(whatsappChannelId), "whatsapp");
    const registry = new TestRegistry();
    registry.setEntry({
      channelDbId: telegramChannelId,
      tenantId,
      tenantSlug: "provider-relay-e2e",
      kind: "telegram_bot",
      adapter: telegramAdapter,
    });
    registry.setEntry({
      channelDbId: whatsappChannelId,
      tenantId,
      tenantSlug: "provider-relay-e2e",
      kind: "whatsapp",
      adapter: whatsappAdapter,
    });
    const dispatcher = new OutboundDispatcher(db, registry, {
      pollMs: 50,
      batchSize: 16,
      metrics,
    });

    const outreach = await withTenant(db, tenantId, (tx) =>
      new ProviderRelayOrchestrator({ db: tx, tenantId }, { metrics }).startProviderOutreach({
        customerContactId,
        customerConversationId: null,
        requestType: "massage",
        serviceArea: "Chaweng",
        summary: "Need massage today around 18:00",
        orderIdempotencyKey: "provider-relay-e2e-order",
        providerRequestIdempotencyKey: "provider-relay-e2e-request",
        outboundIdempotencyKey: "provider-relay-e2e-provider-outbound",
        preferredChannelKinds: ["whatsapp"],
        nowEpoch: now + 10,
      }),
    );
    expect(outreach.ok).toBe(true);
    if (!outreach.ok) throw new Error("expected provider outreach success");
    expect(outreach.candidate.providerId).toBe(providerId);
    expect(outreach.identity.channelDbId).toBe(whatsappChannelId);

    await dispatchOnce(dispatcher);
    expect(whatsappAdapter.sendCalls).toHaveLength(1);
    expect(whatsappAdapter.sendCalls[0]?.transport?.whatsapp?.template).toMatchObject({
      name: "provider_request_v1",
      approved: true,
    });

    const quote = await withTenant(db, tenantId, (tx) =>
      new ProviderResponseHandler({ db: tx, tenantId }, { metrics }).handleProviderResponse({
        inbound: providerInbound(
          "Available today 18:00, price 1,200 THB",
          "wa-provider-quote-e2e",
          now + 100,
        ),
        nowEpoch: now + 100,
      }),
    );
    expect(quote.ok).toBe(true);
    if (!quote.ok) throw new Error("expected provider quote success");
    expect(quote.action).toBe("quoted");

    const offer = await withTenant(db, tenantId, (tx) =>
      new CustomerOfferFlow({ db: tx, tenantId }, { metrics }).sendCustomerOffer({
        orderId: quote.order.id,
        customerChannelId: telegramChannelId,
        offerTextOverride: "Provider is available at 18:00 for 1,380 THB.",
        approvedByAdminId: 42,
        nowEpoch: now + 110,
      }),
    );
    expect(offer.ok).toBe(true);
    if (!offer.ok) throw new Error("expected customer offer success");

    await dispatchOnce(dispatcher);
    expect(telegramAdapter.sendCalls).toHaveLength(1);
    expect(telegramAdapter.sendCalls[0]?.parts[0]).toEqual({
      kind: "text",
      text: "Provider is available at 18:00 for 1,380 THB.",
    });

    const accepted = await withTenant(db, tenantId, (tx) =>
      new CustomerOfferFlow({ db: tx, tenantId }, { metrics }).acceptCustomerOffer({
        orderId: quote.order.id,
        acceptedByContactId: customerContactId,
        nowEpoch: now + 120,
      }),
    );
    expect(accepted.order.status).toBe("awaiting_customer_payment");

    const paid = await withTenant(db, tenantId, (tx) =>
      new CustomerOfferFlow({ db: tx, tenantId }, { metrics }).recordPaymentSuccess({
        orderId: quote.order.id,
        paymentProvider: "manual",
        paymentRef: "provider-relay-e2e-payment",
        nowEpoch: now + 130,
      }),
    );
    expect(paid.ok).toBe(true);
    if (!paid.ok) throw new Error("expected payment success");
    expect(paid.order.status).toBe("confirmed");
    expect(paid.order.paymentStatus).toBe("paid");
    expect(paid.order.commissionAmount).toBe(180);

    await dispatchOnce(dispatcher);
    expect(whatsappAdapter.sendCalls).toHaveLength(2);
    expect(whatsappAdapter.sendCalls[1]?.parts[0]?.kind).toBe("text");

    const events = (
      await withTenant(db, tenantId, (tx) =>
        new ProviderRelayRepo({ db: tx, tenantId }).eventsForOrder(quote.order.id),
      )
    ).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
    expect(events.map((event) => event.eventType)).toEqual([
      "provider_request_created",
      "provider_request_sent",
      "provider_quoted",
      "customer_offer_sent",
      "customer_offer_accepted",
      "payment_intent_created",
      "commission_earned",
      "customer_payment_succeeded",
      "service_order_confirmed",
      "provider_confirmation_sent",
    ]);
    const customerOfferEvent = events.find((event) => event.eventType === "customer_offer_sent");
    expect(JSON.parse(customerOfferEvent?.dataJson ?? "{}")).toMatchObject({
      approvedByAdminId: 42,
      manualOverride: true,
      channelKind: "telegram_bot",
    });

    const [outboundStatuses] = await db
      .select({
        count: schema.outboundQueue.id,
      })
      .from(schema.outboundQueue)
      .where(eq(schema.outboundQueue.status, "failed"))
      .limit(1);
    expect(outboundStatuses).toBeUndefined();

    const exposed = metrics.registry.format();
    expect(exposed).toContain(
      `lead_engine_provider_orders_created_total{request_type="massage",tenant="${tenantId}"} 1`,
    );
    expect(exposed).toContain(
      `lead_engine_provider_requests_total{channel_kind="whatsapp",status="sent",tenant="${tenantId}"} 1`,
    );
    expect(exposed).toContain(
      `lead_engine_provider_responses_total{outcome="quoted",tenant="${tenantId}"} 1`,
    );
    expect(exposed).toContain(
      `lead_engine_provider_time_to_quote_seconds_count{tenant="${tenantId}"} 1`,
    );
    expect(exposed).toContain(
      `lead_engine_provider_time_to_quote_seconds_sum{tenant="${tenantId}"} 90`,
    );
    expect(exposed).toContain(
      `lead_engine_provider_paid_orders_total{currency="THB",tenant="${tenantId}"} 1`,
    );
    expect(exposed).toContain(
      `lead_engine_provider_commission_earned_total{currency="THB",tenant="${tenantId}"} 180`,
    );
    expect(exposed).toContain(
      `lead_engine_outbound_sent_total{kind="whatsapp",tenant="${tenantId}"} 2`,
    );
    expect(exposed).toContain(
      `lead_engine_outbound_sent_total{kind="telegram_bot",tenant="${tenantId}"} 1`,
    );
  });
});
