import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Inbound, InboundPart } from "@chatman-media/channel-core";
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
import { ProviderRelayRepo } from "./dal/provider-relay.ts";
import { ProviderRelayOrchestrator } from "./provider-relay-orchestrator.ts";
import {
	parseProviderResponse,
	ProviderResponseHandler,
} from "./provider-response-handler.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_provider_response_${Math.random().toString(36).slice(2, 10)}`;
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
let whatsappChannelId = 0;
let now = 0;

const providerExternalUserId = "66999999999";
const orchestrator = () => new ProviderRelayOrchestrator({ db, tenantId });
const relayRepo = () => new ProviderRelayRepo({ db, tenantId });
const handler = () => new ProviderResponseHandler({ db, tenantId });

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

async function startOpenRequest(label: string, at: number) {
	const result = await orchestrator().startProviderOutreach({
		customerContactId,
		requestType: "massage",
		serviceArea: "Chaweng",
		summary: `${label} massage request`,
		orderIdempotencyKey: `response-order-${label}`,
		providerRequestIdempotencyKey: `response-provider-request-${label}`,
		outboundIdempotencyKey: `response-outbound-${label}`,
		nowEpoch: at,
	});
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("expected provider outreach success");
	return result;
}

function inbound(parts: InboundPart[], externalMessageId: string, at: number): Inbound {
	return {
		channelId: String(whatsappChannelId),
		externalMessageId,
		externalUserId: providerExternalUserId,
		parts,
		receivedAt: at,
		raw: { test: true },
	};
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
	now = Math.floor(Date.parse("2026-06-09T03:00:00Z") / 1000);

	const [tenant] = await db
		.insert(schema.tenants)
		.values({ slug: `provider-response-${now}`, status: "active" })
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

	customerContactId = await createContact("Response customer");
	providerContactId = await createContact("Response provider contact");
	providerId = await createProvider({
		name: "Response Massage",
		contactId: providerContactId,
		serviceType: "massage",
		serviceArea: "Chaweng",
	});

	const [channel] = await db
		.insert(schema.channels)
		.values({
			tenantId,
			kind: "whatsapp",
			externalId: "phone-number-id-response",
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
		externalUserId: providerExternalUserId,
		createdAt: now,
	});
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("parseProviderResponse", () => {
	it("extracts quotes, availability, and decline intent without LLM calls", () => {
		expect(
			parseProviderResponse([
				{ kind: "text", text: "Available today 18:00, price 1,200 THB" },
			]),
		).toEqual({
			kind: "quote",
			quotedAmount: 1200,
			responseText: "Available today 18:00, price 1,200 THB",
			availabilityText: "today 18:00",
		});
		expect(
			parseProviderResponse([{ kind: "text", text: "Sorry, no slots today" }]),
		).toMatchObject({ kind: "decline", availabilityText: "today" });
		expect(
			parseProviderResponse([{ kind: "text", text: "Let me check" }]),
		).toMatchObject({ kind: "ambiguous" });
	});
});

describe("ProviderResponseHandler", () => {
	it("associates provider quote with the open request and does not notify customer", async () => {
		if (!enabled) return;
		const outreach = await startOpenRequest("quote", now + 10);
		expect(outreach.candidate.providerId).toBe(providerId);
		const outboundBefore = await tableCount("outbound_queue");

		const result = await handler().handleProviderResponse({
			inbound: inbound(
				[{ kind: "text", text: "Available today 18:00, price 1,200 THB" }],
				"wa-quote-1",
				now + 20,
			),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected quote result");
		expect(result.action).toBe("quoted");
		expect(result.providerRequest).toMatchObject({
			id: outreach.providerRequest.id,
			status: "quoted",
			quotedAmount: 1200,
			responseText: "Available today 18:00, price 1,200 THB",
		});
		expect(result.order).toMatchObject({
			id: outreach.order.id,
			status: "offer_ready",
			quotedAmount: 1200,
			assignedProviderId: providerId,
		});
		expect(await tableCount("outbound_queue")).toBe(outboundBefore);

		const events = await relayRepo().eventsForOrder(outreach.order.id);
		const quoteEvent = events.find(
			(event) => event.eventType === "provider_quoted",
		);
		expect(quoteEvent).toBeTruthy();
		const data = JSON.parse(quoteEvent?.dataJson ?? "{}");
		expect(data).toMatchObject({
			source: "provider_inbound",
			parseKind: "quote",
			externalMessageId: "wa-quote-1",
			channelId: whatsappChannelId,
			externalUserId: providerExternalUserId,
			availabilityText: "today 18:00",
			quotedAmount: 1200,
			customerAmount: 1380,
			commissionPct: 15,
			commissionAmount: 180,
		});
	});

	it("records provider decline on the linked request", async () => {
		if (!enabled) return;
		const outreach = await startOpenRequest("decline", now + 30);
		const outboundBefore = await tableCount("outbound_queue");

		const result = await handler().handleProviderResponse({
			inbound: inbound(
				[{ kind: "text", text: "Sorry, no slots today" }],
				"wa-decline-1",
				now + 40,
			),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected decline result");
		expect(result.action).toBe("declined");
		expect(result.providerRequest).toMatchObject({
			id: outreach.providerRequest.id,
			status: "declined",
			responseText: "Sorry, no slots today",
		});
		expect(result.order).toMatchObject({
			id: outreach.order.id,
			status: "provider_declined",
		});
		expect(await tableCount("outbound_queue")).toBe(outboundBefore);

		const events = await relayRepo().eventsForOrder(outreach.order.id);
		const declineEvent = events.find(
			(event) => event.eventType === "provider_declined",
		);
		expect(JSON.parse(declineEvent?.dataJson ?? "{}")).toMatchObject({
			source: "provider_inbound",
			parseKind: "decline",
			externalMessageId: "wa-decline-1",
			responseText: "Sorry, no slots today",
		});
	});

	it("keeps ambiguous replies internal and creates an operator-review event", async () => {
		if (!enabled) return;
		const outreach = await startOpenRequest("ambiguous", now + 50);
		const outboundBefore = await tableCount("outbound_queue");

		const result = await handler().handleProviderResponse({
			inbound: inbound(
				[{ kind: "text", text: "Let me check and send menu" }],
				"wa-ambiguous-1",
				now + 60,
			),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ambiguous result");
		expect(result.action).toBe("ambiguous");
		expect(result.providerRequest).toMatchObject({
			id: outreach.providerRequest.id,
			status: "sent",
		});
		expect(result.order).toMatchObject({
			id: outreach.order.id,
			status: "awaiting_provider",
		});
		expect(await tableCount("outbound_queue")).toBe(outboundBefore);

		const events = await relayRepo().eventsForOrder(outreach.order.id);
		const ambiguousEvent = events.find(
			(event) => event.eventType === "provider_response_ambiguous",
		);
		expect(ambiguousEvent).toBeTruthy();
		expect(JSON.parse(ambiguousEvent?.dataJson ?? "{}")).toMatchObject({
			source: "provider_inbound",
			parseKind: "ambiguous",
			externalMessageId: "wa-ambiguous-1",
			responseText: "Let me check and send menu",
			operatorAction: "review_provider_response",
		});
	});

	it("attaches provider media metadata to order events", async () => {
		if (!enabled) return;
		const outreach = await startOpenRequest("media", now + 70);

		const result = await handler().handleProviderResponse({
			inbound: inbound(
				[
					{ kind: "text", text: "Please check menu" },
					{
						kind: "document",
						mediaRef: {
							channelId: String(whatsappChannelId),
							externalRef: "wa-doc-1",
						},
						mimeType: "application/pdf",
						fileName: "menu.pdf",
					},
					{
						kind: "photo",
						mediaRef: {
							channelId: String(whatsappChannelId),
							externalRef: "wa-photo-1",
						},
						caption: "Room photo",
					},
				],
				"wa-media-1",
				now + 80,
			),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected media result");
		expect(result.action).toBe("ambiguous");

		const events = await relayRepo().eventsForOrder(outreach.order.id);
		const mediaEvent = events.find(
			(event) => event.eventType === "provider_response_ambiguous",
		);
		const data = JSON.parse(mediaEvent?.dataJson ?? "{}");
		expect(data).toMatchObject({
			source: "provider_inbound",
			externalMessageId: "wa-media-1",
			responseText: "Please check menu\nRoom photo",
		});
		expect(data.mediaParts).toEqual([
			{
				kind: "document",
				mediaRef: {
					channelId: String(whatsappChannelId),
					externalRef: "wa-doc-1",
				},
				mimeType: "application/pdf",
				fileName: "menu.pdf",
			},
			{
				kind: "photo",
				mediaRef: {
					channelId: String(whatsappChannelId),
					externalRef: "wa-photo-1",
				},
				caption: "Room photo",
			},
		]);
	});

	it("ignores provider-looking messages without an open request match", async () => {
		if (!enabled) return;
		const outboundBefore = await tableCount("outbound_queue");
		const result = await handler().handleProviderResponse({
			inbound: {
				...inbound([{ kind: "text", text: "1200 THB" }], "wa-unknown-1", now + 90),
				externalUserId: "unknown-provider",
			},
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "provider_request_not_found",
		});
		expect(await tableCount("outbound_queue")).toBe(outboundBefore);
	});
});
