import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	applyAllMigrations,
	createIsolatedDb,
	schema,
	tryConnectToPg,
} from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { ProviderRelayRepo } from "./dal/provider-relay.ts";
import { ProviderRelayOrchestrator } from "./provider-relay-orchestrator.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_provider_orch_${Math.random().toString(36).slice(2, 10)}`;
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
let providerWithoutChannelId = 0;
let whatsappChannelId = 0;
let now = 0;

const orchestrator = () => new ProviderRelayOrchestrator({ db, tenantId });
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

async function createProvider(opts: {
	name: string;
	contactId: number;
	serviceType: string;
	serviceArea?: string | null;
}): Promise<number> {
	const [provider] = await db
		.insert(schema.providerProfiles)
		.values({
			tenantId,
			contactId: opts.contactId,
			name: opts.name,
			category: opts.serviceType,
			status: "active",
			serviceArea: opts.serviceArea ?? null,
			defaultCommissionPct: 15,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.providerProfiles.id });
	if (!provider) throw new Error("provider insert returned no row");

	await db.insert(schema.providerServices).values({
		tenantId,
		providerId: provider.id,
		serviceType: opts.serviceType,
		name: `${opts.name} service`,
		serviceArea: opts.serviceArea ?? null,
		isActive: true,
		createdAt: now,
		updatedAt: now,
	});

	return provider.id;
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
	now = Math.floor(Date.parse("2026-06-09T02:00:00Z") / 1000);

	const [tenant] = await db
		.insert(schema.tenants)
		.values({ slug: `provider-orchestrator-${now}`, status: "active" })
		.returning({ id: schema.tenants.id });
	if (!tenant) throw new Error("tenant insert returned no row");
	tenantId = tenant.id;

	customerContactId = await createContact("Relay customer");
	providerContactId = await createContact("WhatsApp provider contact");
	const noChannelContactId = await createContact("No channel provider contact");

	providerId = await createProvider({
		name: "WhatsApp Massage",
		contactId: providerContactId,
		serviceType: "massage",
		serviceArea: "Chaweng",
	});
	providerWithoutChannelId = await createProvider({
		name: "No Channel Spa",
		contactId: noChannelContactId,
		serviceType: "spa_package",
		serviceArea: "Chaweng",
	});

	const [channel] = await db
		.insert(schema.channels)
		.values({
			tenantId,
			kind: "whatsapp",
			externalId: "phone-number-id-1",
			status: "active",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.channels.id });
	if (!channel) throw new Error("channel insert returned no row");
	whatsappChannelId = channel.id;

	await db.insert(schema.channelIdentities).values({
		contactId: providerContactId,
		channelId: whatsappChannelId,
		externalUserId: "66999999999",
		createdAt: now,
	});
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("ProviderRelayOrchestrator", () => {
	it("creates order/request, enqueues provider outbound, and records sent events", async () => {
		if (!enabled) return;
		const result = await orchestrator().startProviderOutreach({
			customerContactId,
			requestType: "massage",
			serviceArea: "Chaweng",
			summary: "Massage today around 18:00",
			orderIdempotencyKey: "orch-order-1",
			nowEpoch: now + 10,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected successful provider outreach");
		expect(result.candidate.providerId).toBe(providerId);
		expect(result.identity.channelDbId).toBe(whatsappChannelId);
		expect(result.envelope).toMatchObject({
			channelId: String(whatsappChannelId),
			externalUserId: "66999999999",
			idempotencyKey: `provider-relay:${result.order.id}:${providerId}:${whatsappChannelId}:initial`,
		});
		expect(result.providerRequest).toMatchObject({
			orderId: result.order.id,
			providerId,
			channelId: whatsappChannelId,
			outboundQueueId: result.outbound.id,
			status: "sent",
			sentAt: now + 10,
		});
		expect(result.order.assignedProviderId).toBe(providerId);
		expect(result.outbound.status).toBe("pending");
		expect(result.outbound.externalMessageId).toBeNull();

		const payload = JSON.parse(result.outbound.payloadJson);
		expect(payload.parts[0].text).toContain("Massage today around 18:00");

		const events = await relayRepo().eventsForOrder(result.order.id);
		expect(new Set(events.map((event) => event.eventType))).toEqual(
			new Set(["provider_request_created", "provider_request_sent"]),
		);
	});

	it("is idempotent for order, outbound queue, provider request, and sent event", async () => {
		if (!enabled) return;
		const first = await orchestrator().startProviderOutreach({
			customerContactId,
			requestType: "massage",
			serviceArea: "Chaweng",
			summary: "Repeat request",
			orderIdempotencyKey: "orch-order-idem",
			providerRequestIdempotencyKey: "orch-provider-request-idem",
			outboundIdempotencyKey: "orch-outbound-idem",
			nowEpoch: now + 20,
		});
		const second = await orchestrator().startProviderOutreach({
			customerContactId,
			requestType: "massage",
			serviceArea: "Chaweng",
			summary: "Repeat request should not duplicate",
			orderIdempotencyKey: "orch-order-idem",
			providerRequestIdempotencyKey: "orch-provider-request-idem",
			outboundIdempotencyKey: "orch-outbound-idem",
			nowEpoch: now + 21,
		});

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) throw new Error("expected success");
		expect(second.order.id).toBe(first.order.id);
		expect(second.outbound.id).toBe(first.outbound.id);
		expect(second.providerRequest.id).toBe(first.providerRequest.id);

		const events = await relayRepo().eventsForOrder(first.order.id);
		expect(
			events.filter((event) => event.eventType === "provider_request_sent"),
		).toHaveLength(1);
	});

	it("records route failure without creating provider request or outbound rows", async () => {
		if (!enabled) return;
		const beforeRequests = await tableCount("provider_requests");
		const beforeOutbound = await tableCount("outbound_queue");

		const result = await orchestrator().startProviderOutreach({
			customerContactId,
			requestType: "missing_service",
			serviceArea: "Chaweng",
			orderIdempotencyKey: "orch-route-failure",
			nowEpoch: now + 30,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "routing_failed",
			routingReason: "no_provider_available",
		});
		expect(await tableCount("provider_requests")).toBe(beforeRequests);
		expect(await tableCount("outbound_queue")).toBe(beforeOutbound);
		const events = await relayRepo().eventsForOrder(result.order.id);
		expect(events.map((event) => event.eventType)).toEqual([
			"provider_route_failed",
		]);
	});

	it("records missing provider channel without creating provider request or outbound rows", async () => {
		if (!enabled) return;
		const beforeRequests = await tableCount("provider_requests");
		const beforeOutbound = await tableCount("outbound_queue");

		const result = await orchestrator().startProviderOutreach({
			customerContactId,
			requestType: "spa_package",
			serviceArea: "Chaweng",
			providerIdOverride: providerWithoutChannelId,
			orderIdempotencyKey: "orch-no-channel",
			nowEpoch: now + 40,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "provider_channel_missing",
			providerId: providerWithoutChannelId,
		});
		expect(await tableCount("provider_requests")).toBe(beforeRequests);
		expect(await tableCount("outbound_queue")).toBe(beforeOutbound);
		const events = await relayRepo().eventsForOrder(result.order.id);
		expect(events.map((event) => event.eventType)).toEqual([
			"provider_request_failed",
		]);
	});

	it("records retry, failed, and cancelled dispatch events", async () => {
		if (!enabled) return;
		const result = await orchestrator().startProviderOutreach({
			customerContactId,
			requestType: "massage",
			serviceArea: "Chaweng",
			orderIdempotencyKey: "orch-dispatch-events",
			nowEpoch: now + 50,
		});
		if (!result.ok) throw new Error("expected successful provider outreach");

		await orchestrator().recordDispatchRetry({
			providerRequestId: result.providerRequest.id,
			error: "rate limit",
			nowEpoch: now + 51,
		});
		await orchestrator().recordDispatchFailed({
			providerRequestId: result.providerRequest.id,
			error: "template rejected",
			nowEpoch: now + 52,
		});
		const cancelled = await orchestrator().cancelProviderOutreach({
			providerRequestId: result.providerRequest.id,
			reason: "operator cancelled",
			nowEpoch: now + 53,
		});

		expect(cancelled.status).toBe("cancelled");
		const events = await relayRepo().eventsForOrder(result.order.id);
		expect(events.map((event) => event.eventType)).toEqual([
			"provider_request_cancelled",
			"provider_request_send_failed",
			"provider_request_retry",
			"provider_request_sent",
			"provider_request_created",
		]);

		const [stored] = await db
			.select({ status: schema.providerRequests.status })
			.from(schema.providerRequests)
			.where(eq(schema.providerRequests.id, result.providerRequest.id));
		expect(stored?.status).toBe("cancelled");
	});
});
