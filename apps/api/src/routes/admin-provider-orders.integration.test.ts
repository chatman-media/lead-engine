import {
	applyAllMigrations,
	createIsolatedDb,
	schema,
	tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminProviderOrdersRoutes } from "./admin-provider-orders.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_provider_orders_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-provider-orders-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;
let customerContactId = 0;
let providerId = 0;
let providerChannelId = 0;
let orderId = 0;
let requestId = 0;
let confirmedOrderId = 0;
let paidAwaitingOrderId = 0;
let retryOrderId = 0;
let now = 0;

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
	app.route("/", makeAdminProviderOrdersRoutes({ db }));

	const signup = await app.request("/api/auth/signup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: "provider-orders@demo.io",
			password: "strong-pwd-12345",
		}),
	});
	const auth = (await signup.json()) as {
		token: string;
		tenant: { id: number };
	};
	token = auth.token;
	tenantId = auth.tenant.id;
	now = Math.floor(Date.parse("2026-06-09T04:00:00Z") / 1000);
	await db.insert(schema.tenantFeatureFlags).values({
		tenantId,
		featureKey: "provider_relay",
		enabled: true,
		createdAt: now,
		updatedAt: now,
	});

	await seedBrokerOrder();
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

async function seedBrokerOrder() {
	const [customer] = await db
		.insert(schema.contacts)
		.values({
			tenantId,
			displayName: "Ada Customer",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.contacts.id });
	const [providerContact] = await db
		.insert(schema.contacts)
		.values({
			tenantId,
			displayName: "Provider Contact",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.contacts.id });
	if (!customer || !providerContact) throw new Error("seed contacts failed");
	customerContactId = customer.id;

	const [customerChannel] = await db
		.insert(schema.channels)
		.values({
			tenantId,
			kind: "telegram_bot",
			externalId: "bot-orders",
			status: "active",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.channels.id });
	const [providerChannel] = await db
		.insert(schema.channels)
		.values({
			tenantId,
			kind: "whatsapp",
			externalId: "wa-orders",
			status: "active",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.channels.id });
	if (!customerChannel || !providerChannel) throw new Error("seed channels failed");
	providerChannelId = providerChannel.id;

	await db.insert(schema.channelIdentities).values([
		{
			contactId: customerContactId,
			channelId: customerChannel.id,
			externalUserId: "customer-ext",
			createdAt: now,
		},
		{
			contactId: providerContact.id,
			channelId: providerChannel.id,
			externalUserId: "66999999999",
			createdAt: now,
		},
	]);

	const [provider] = await db
		.insert(schema.providerProfiles)
		.values({
			tenantId,
			contactId: providerContact.id,
			name: "Samui Massage",
			category: "massage",
			status: "active",
			serviceArea: "Chaweng",
			defaultCommissionPct: 12,
			metadataJson: JSON.stringify({
				whatsappOptIn: {
					source: "manual_onboarding",
					acceptedAt: now,
					categories: ["provider_outreach", "utility"],
				},
			}),
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.providerProfiles.id });
	if (!provider) throw new Error("seed provider failed");
	providerId = provider.id;

	await db.insert(schema.providerServices).values({
		tenantId,
		providerId,
		serviceType: "massage",
		name: "In-room massage",
		serviceArea: "Chaweng",
		commissionPct: 12,
		isActive: true,
		createdAt: now,
		updatedAt: now,
	});

	const [conversation] = await db
		.insert(schema.conversations)
		.values({
			tenantId,
			userId: customerContactId,
			source: "bot",
			channelId: customerChannel.id,
			mode: "ai",
			status: "open",
			lastMessageAt: now + 1,
			createdAt: now,
		})
		.returning({ id: schema.conversations.id });
	if (!conversation) throw new Error("seed conversation failed");
	await db.insert(schema.messages).values({
		tenantId,
		conversationId: conversation.id,
		role: "user",
		text: "Need massage tonight",
		createdAt: now + 1,
	});

	const [order] = await db
		.insert(schema.serviceOrders)
		.values({
			tenantId,
			customerContactId,
			customerConversationId: conversation.id,
			assignedProviderId: providerId,
			requestType: "massage",
			status: "offer_ready",
			summary: "Massage tonight around 20:00",
			quotedAmount: 1000,
			customerAmount: 1120,
			commissionPct: 12,
			commissionAmount: 120,
			currency: "THB",
			paymentStatus: "unpaid",
			metadataJson: JSON.stringify({ serviceArea: "Chaweng" }),
			expiresAt: now + 7200,
			createdAt: now,
			updatedAt: now + 2,
		})
		.returning({ id: schema.serviceOrders.id });
	if (!order) throw new Error("seed order failed");
	orderId = order.id;

	const [outbound] = await db
		.insert(schema.outboundQueue)
		.values({
			tenantId,
			channelId: providerChannel.id,
			payloadJson: JSON.stringify({
				channelId: String(providerChannel.id),
				externalUserId: "66999999999",
				parts: [{ kind: "text", text: "Provider visible request" }],
			}),
			idempotencyKey: "seed-provider-request",
			status: "sent",
			scheduledAt: now + 2,
			sentAt: now + 3,
			createdAt: now + 2,
		})
		.returning({ id: schema.outboundQueue.id });
	if (!outbound) throw new Error("seed outbound failed");

	const [request] = await db
		.insert(schema.providerRequests)
		.values({
			tenantId,
			orderId,
			providerId,
			channelId: providerChannel.id,
			outboundQueueId: outbound.id,
			status: "quoted",
			quotedAmount: 1000,
			customerAmount: 1120,
			commissionAmount: 120,
			currency: "THB",
			availableAt: now + 3600,
			quoteExpiresAt: now + 5400,
			responseText: "Available at 20:00",
			sentAt: now + 2,
			respondedAt: now + 4,
			createdAt: now + 2,
			updatedAt: now + 4,
		})
		.returning({ id: schema.providerRequests.id });
	if (!request) throw new Error("seed request failed");
	requestId = request.id;

	await db.insert(schema.orderEvents).values({
		tenantId,
		orderId,
		providerRequestId: requestId,
		actorType: "provider",
		eventType: "provider_quoted",
		dataJson: JSON.stringify({ availabilityText: "20:00" }),
		createdAt: now + 4,
	});
	await db.insert(schema.orderEvents).values({
		tenantId,
		orderId,
		providerRequestId: requestId,
		actorType: "system",
		eventType: "provider_request_send_failed",
		dataJson: JSON.stringify({
			error: "WhatsApp temporarily unavailable",
			channelKind: "whatsapp",
		}),
		createdAt: now + 5,
	});

	const [confirmed] = await db
		.insert(schema.serviceOrders)
		.values({
			tenantId,
			customerContactId,
			assignedProviderId: providerId,
			requestType: "massage",
			status: "confirmed",
			summary: "Paid booking",
			paymentStatus: "paid",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.serviceOrders.id });
	const [paidAwaiting] = await db
		.insert(schema.serviceOrders)
		.values({
			tenantId,
			customerContactId,
			assignedProviderId: providerId,
			requestType: "massage",
			status: "awaiting_customer_payment",
			summary: "Paid order awaiting confirmation",
			paymentStatus: "paid",
			commissionAmount: 180,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.serviceOrders.id });
	const [retry] = await db
		.insert(schema.serviceOrders)
		.values({
			tenantId,
			customerContactId,
			assignedProviderId: providerId,
			requestType: "massage",
			status: "provider_declined",
			summary: "Retry provider request",
			metadataJson: JSON.stringify({ serviceArea: "Chaweng" }),
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.serviceOrders.id });
	if (!confirmed || !paidAwaiting || !retry) {
		throw new Error("seed action orders failed");
	}
	confirmedOrderId = confirmed.id;
	paidAwaitingOrderId = paidAwaiting.id;
	retryOrderId = retry.id;
}

async function createRetryOrder(summary: string): Promise<number> {
	const [row] = await db
		.insert(schema.serviceOrders)
		.values({
			tenantId,
			customerContactId,
			assignedProviderId: providerId,
			requestType: "massage",
			status: "provider_declined",
			summary,
			metadataJson: JSON.stringify({ serviceArea: "Chaweng" }),
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.serviceOrders.id });
	if (!row) throw new Error("retry order insert failed");
	return row.id;
}

async function outboundRowCount(): Promise<number> {
	return (
		await db
			.select({ id: schema.outboundQueue.id })
			.from(schema.outboundQueue)
			.where(eq(schema.outboundQueue.tenantId, tenantId))
	).length;
}

async function setProviderRelayFlag(enabled: boolean): Promise<void> {
	await db
		.update(schema.tenantFeatureFlags)
		.set({ enabled, updatedAt: now + 100 })
		.where(eq(schema.tenantFeatureFlags.tenantId, tenantId));
}

describe("admin provider orders", () => {
	it("exposes ops settings and metrics and blocks writes when disabled", async () => {
		if (!sql) return;

		const opsRes = await authReq("/api/admin/provider-orders/ops");
		expect(opsRes.status).toBe(200);
		const ops = (await opsRes.json()) as {
			settings: { enabled: boolean; source: string };
			metrics: {
				ordersCreated: number;
				providerRequestsSent: number;
				providerResponseRatePct: number | null;
				avgTimeToQuoteSec: number | null;
				paidOrders: number;
				commissionAmountTotal: number;
				failuresByChannel: Record<string, number>;
				failedDispatches: number;
				stuckOrders: { count: number };
			};
		};
		expect(ops.settings).toMatchObject({ enabled: true, source: "flag" });
		expect(ops.metrics.ordersCreated).toBeGreaterThanOrEqual(4);
		expect(ops.metrics.providerRequestsSent).toBe(1);
		expect(ops.metrics.providerResponseRatePct).toBe(100);
		expect(ops.metrics.avgTimeToQuoteSec).toBe(2);
		expect(ops.metrics.paidOrders).toBeGreaterThanOrEqual(2);
		expect(ops.metrics.commissionAmountTotal).toBeGreaterThanOrEqual(300);
		expect(ops.metrics.failuresByChannel.whatsapp).toBe(1);
		expect(ops.metrics.failedDispatches).toBe(1);
		expect(ops.metrics.stuckOrders.count).toBeGreaterThanOrEqual(1);

		const disableRes = await authReq(
			"/api/admin/provider-orders/ops/settings",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			},
		);
		expect(disableRes.status).toBe(200);

		const blockedRes = await authReq(
			`/api/admin/provider-orders/${orderId}/assign-provider`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ providerId }),
			},
		);
		expect(blockedRes.status).toBe(403);
		expect(await blockedRes.json()).toMatchObject({
			error: "provider_relay_disabled",
		});

		const enableRes = await authReq("/api/admin/provider-orders/ops/settings", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		expect(enableRes.status).toBe(200);
	});

	it("lists order SLA columns and loads detail visibility sections", async () => {
		if (!sql) return;

		const listRes = await authReq("/api/admin/provider-orders");
		expect(listRes.status).toBe(200);
		const list = (await listRes.json()) as {
			items: Array<{
				id: number;
				customer: { name: string | null };
				provider: { name: string } | null;
				requestType: string;
				customerAmount: number | null;
				latestProviderRequest: { status: string } | null;
				sla: { state: string; dueAt: number | null };
			}>;
		};
		const item = list.items.find((row) => row.id === orderId);
		expect(item).toBeTruthy();
		expect(item?.customer.name).toBe("Ada Customer");
		expect(item?.provider?.name).toBe("Samui Massage");
		expect(item?.requestType).toBe("massage");
		expect(item?.customerAmount).toBe(1120);
		expect(item?.latestProviderRequest?.status).toBe("quoted");
		expect(item?.sla.dueAt).toBe(now + 5400);

		const detailRes = await authReq(`/api/admin/provider-orders/${orderId}`);
		expect(detailRes.status).toBe(200);
		const detail = (await detailRes.json()) as {
			customer: { messages: Array<{ text: string }> };
			providerRequests: Array<{ outboundText: string | null; responseText: string | null }>;
			events: Array<{ eventType: string; data: Record<string, unknown> }>;
			order: { payment: { status: string } };
		};
		expect(detail.customer.messages[0]?.text).toBe("Need massage tonight");
		expect(detail.providerRequests[0]?.outboundText).toBe("Provider visible request");
		expect(detail.providerRequests[0]?.responseText).toBe("Available at 20:00");
		expect(detail.events[0]?.eventType).toBe("provider_quoted");
		expect(detail.order.payment.status).toBe("unpaid");
	});

	it("runs operator actions for provider workflow", async () => {
		if (!sql) return;

		const providersRes = await authReq(
			"/api/admin/provider-orders/providers?requestType=massage",
		);
		expect(providersRes.status).toBe(200);
		const providers = (await providersRes.json()) as {
			items: Array<{ id: number; services: Array<{ serviceType: string }> }>;
		};
		expect(providers.items.some((provider) => provider.id === providerId)).toBe(
			true,
		);

		const assignRes = await authReq(
			`/api/admin/provider-orders/${orderId}/assign-provider`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ providerId }),
			},
		);
		expect(assignRes.status).toBe(200);

		const retryRes = await authReq(
			`/api/admin/provider-orders/${retryOrderId}/send-provider-request`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ providerId, messageText: "Manual provider request" }),
			},
		);
		expect(retryRes.status).toBe(200);
		const retryPayload = (await retryRes.json()) as {
			providerRequest: { status: string };
			outbound: { id: number };
		};
		expect(retryPayload.providerRequest.status).toBe("sent");
		expect(retryPayload.outbound.id).toBeGreaterThan(0);

		const approveRes = await authReq(
			`/api/admin/provider-orders/${orderId}/approve-quote`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ providerRequestId: requestId }),
			},
		);
		expect(approveRes.status).toBe(200);

		const offerRes = await authReq(
			`/api/admin/provider-orders/${orderId}/send-customer-offer`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					offerText: "Operator edited customer offer",
					paymentInstructions: "Pay cash to operator",
				}),
			},
		);
		expect(offerRes.status).toBe(200);

		const cancelRes = await authReq(`/api/admin/provider-orders/${orderId}/cancel`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "customer cancelled" }),
		});
		expect(cancelRes.status).toBe(200);
		const [cancelled] = await db
			.select({ status: schema.serviceOrders.status })
			.from(schema.serviceOrders)
			.where(eq(schema.serviceOrders.id, orderId));
		expect(cancelled?.status).toBe("cancelled");

		const fulfillRes = await authReq(
			`/api/admin/provider-orders/${confirmedOrderId}/mark-fulfilled`,
			{ method: "POST" },
		);
		expect(fulfillRes.status).toBe(200);
		const [fulfilled] = await db
			.select({ status: schema.serviceOrders.status })
			.from(schema.serviceOrders)
			.where(eq(schema.serviceOrders.id, confirmedOrderId));
		expect(fulfilled?.status).toBe("fulfilled");

		const transitionRes = await authReq(
			`/api/admin/provider-orders/${paidAwaitingOrderId}/mark-fulfilled`,
			{ method: "POST" },
		);
		expect(transitionRes.status).toBe(200);
		const [paidTransitioned] = await db
			.select({ status: schema.serviceOrders.status })
			.from(schema.serviceOrders)
			.where(eq(schema.serviceOrders.id, paidAwaitingOrderId));
		expect(paidTransitioned?.status).toBe("fulfilled");

		const auditRows = await db
			.select({
				action: schema.auditLog.action,
				targetId: schema.auditLog.targetId,
				detailsJson: schema.auditLog.detailsJson,
			})
			.from(schema.auditLog)
			.where(eq(schema.auditLog.tenantId, tenantId));
		const actions = auditRows.map((row) => row.action);
		expect(actions).toContain("provider_relay.settings_update");
		expect(actions).toContain("provider_order.assign_provider");
		expect(actions).toContain("provider_order.send_provider_request");
		expect(actions).toContain("provider_order.approve_quote");
		expect(actions).toContain("provider_order.send_customer_offer");
		expect(actions).toContain("provider_order.manual_offer_override");
		expect(actions).toContain("provider_order.cancel");
		expect(actions).toContain("provider_order.mark_fulfilled");
		expect(actions).toContain("provider_order.payment_transition");
		const manualOverride = auditRows.find(
			(row) => row.action === "provider_order.manual_offer_override",
		);
		expect(manualOverride?.targetId).toBe(String(orderId));
		const paymentTransition = auditRows.find(
			(row) =>
				row.action === "provider_order.payment_transition" &&
				row.targetId === String(paidAwaitingOrderId),
		);
		expect(JSON.parse(paymentTransition?.detailsJson ?? "{}")).toMatchObject({
			transitions: [
				{ from: "awaiting_customer_payment", to: "paid" },
				{ from: "paid", to: "confirmed" },
				{ from: "confirmed", to: "fulfilled" },
			],
		});
	});

	it("blocks manual provider request when provider relay rollout flag is disabled", async () => {
		if (!sql) return;
		const disabledOrderId = await createRetryOrder("Disabled rollout retry");
		const outboundBefore = await outboundRowCount();

		await setProviderRelayFlag(false);
		try {
			const res = await authReq(
				`/api/admin/provider-orders/${disabledOrderId}/send-provider-request`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						providerId,
						messageText: "Should not be enqueued",
					}),
				},
			);
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: "provider_relay_disabled",
			});
			expect(await outboundRowCount()).toBe(outboundBefore);
		} finally {
			await setProviderRelayFlag(true);
		}
	});
});
