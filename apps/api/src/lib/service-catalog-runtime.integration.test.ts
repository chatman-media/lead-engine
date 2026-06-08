import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
	applyAllMigrations,
	contacts,
	createIsolatedDb,
	funnels,
	leadFieldValues,
	leads,
	partnerDeals,
	partnerServices,
	partners,
	schema,
	serviceCatalogItems,
	stageDefinitions,
	stageFields,
	tryConnectToPg,
} from "@chatman-media/storage";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { makeAuthRoutes } from "../routes/auth.ts";
import {
	deterministicCatalogMatches,
	makeServiceCatalogRuntime,
} from "./service-catalog-runtime.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_service_runtime_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-service-runtime-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;

interface Fixture {
	contactId: number;
	stageId: number;
	transferServiceId: number;
}

function expectInserted<T>(row: T | undefined, label: string): T {
	if (!row) throw new Error(`failed to insert ${label}`);
	return row;
}

beforeAll(async () => {
	if (!ownerUrl) return;
	const probe = await tryConnectToPg(ownerUrl);
	if (!probe) return;
	await probe.end({ timeout: 0 });

	const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
	sql = postgres(testUrl, { max: 2, onnotice: () => {} });
	await applyAllMigrations(sql, migrationsDir);
	db = drizzle(sql, { schema });

	const app = new Hono();
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle generic in test harness
	app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
	const res = await app.request("/api/auth/signup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: `service-runtime-${Date.now()}@demo.io`,
			password: "strong-pwd-12345",
		}),
	});
	const body = (await res.json()) as { admin: { tenantId: number } };
	tenantId = body.admin.tenantId;
}, 30_000);

afterAll(async () => {
	if (sql) {
		await sql.end({ timeout: 0 }).catch(() => {});
		sql = null;
	}
}, 10_000);

async function seedFixture(): Promise<Fixture> {
	return withTenant(db as Db, tenantId, async (tx) => {
		const now = 1_800_000_000;
		const [insertedContact] = await tx
			.insert(contacts)
			.values({
				tenantId,
				displayName: "Guest Max",
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: contacts.id });
		const contact = expectInserted(insertedContact, "contact");

		const [insertedFunnel] = await tx
			.insert(funnels)
			.values({
				tenantId,
				slug: `ops_${Math.random().toString(36).slice(2, 8)}`,
				stagesJson: "[]",
				isActive: true,
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: funnels.id });
		const funnel = expectInserted(insertedFunnel, "funnel");

		const [insertedStage] = await tx
			.insert(stageDefinitions)
			.values({
				tenantId,
				funnelId: funnel.id,
				slug: "awaiting_operator",
				displayName: "Awaiting operator",
				position: 1,
				kind: "active",
				stageType: "awaiting_operator",
				phase: "offer",
				nextStages: [],
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: stageDefinitions.id });
		const stage = expectInserted(insertedStage, "stage");

		await tx.insert(stageFields).values([
			{
				tenantId,
				stageId: stage.id,
				slug: "route",
				displayName: "Route",
				fieldType: "text",
				aiExtractable: true,
				position: 1,
				createdAt: now,
			},
			{
				tenantId,
				stageId: stage.id,
				slug: "pickup_time",
				displayName: "Pickup time",
				fieldType: "text",
				aiExtractable: true,
				position: 2,
				createdAt: now,
			},
		]);

		const [insertedPartner] = await tx
			.insert(partners)
			.values({
				tenantId,
				name: "Phuket Transfer Network",
				status: "active",
				defaultCommissionPct: 10,
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: partners.id });
		const partner = expectInserted(insertedPartner, "partner");

		const [insertedTransferService] = await tx
			.insert(partnerServices)
			.values({
				tenantId,
				partnerId: partner.id,
				name: "Transfer and driver",
				category: "Transfer",
				commissionPct: 12,
				notes: JSON.stringify({ handoffMode: "await_callback" }),
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: partnerServices.id });
		const transferService = expectInserted(
			insertedTransferService,
			"transfer service",
		);

		await tx.insert(serviceCatalogItems).values([
			{
				tenantId,
				slug: "transfer_provider",
				name: "Трансфер и водитель",
				category: "Трансфер",
				routeType: "partner_service",
				partnerServiceId: transferService.id,
				metadataJson: JSON.stringify({
					requiredFields: ["route", "pickup_time"],
					handoffMode: "await_callback",
				}),
				isActive: true,
				sortOrder: 10,
				createdAt: now,
				updatedAt: now,
			},
			{
				tenantId,
				slug: "cleaning_provider",
				name: "Уборка и laundry",
				category: "Уборка",
				routeType: "manual",
				metadataJson: JSON.stringify({ requiredFields: ["address", "scope"] }),
				isActive: true,
				sortOrder: 20,
				createdAt: now,
				updatedAt: now,
			},
		]);

		return {
			contactId: contact.id,
			stageId: stage.id,
			transferServiceId: transferService.id,
		};
	});
}

describe("service catalog runtime", () => {
	it("matches multiple services deterministically from one message", () => {
		const matches = deterministicCatalogMatches(
			"нужен трансфер из аэропорта и уборка после checkout",
			[
				{
					id: 1,
					slug: "transfer_provider",
					name: "Трансфер и водитель",
					category: "Трансфер",
				},
				{
					id: 2,
					slug: "cleaning_provider",
					name: "Уборка и laundry",
					category: "Уборка",
				},
			],
		);

		expect(matches.map((match) => match.requestType).sort()).toEqual([
			"cleaning",
			"transfer",
		]);
	});

	it("creates one lead per requested service and a partner deal for provider services", async () => {
		if (!sql) return;
		const fixture = await seedFixture();
		const runtime = makeServiceCatalogRuntime({
			now: () => 1_800_000_100,
			resolveChat: () =>
				({
					complete: async () =>
						JSON.stringify({
							requests: [
								{
									slug: "transfer_provider",
									confidence: 0.99,
									fields: {
										route: "HKT airport -> Kata",
										pickup_time: "tomorrow 10:00",
									},
								},
								{
									slug: "cleaning_provider",
									confidence: 0.98,
									fields: { address: "Villa 7" },
								},
							],
						}),
				}) as never,
		});

		const result = await runtime.extract({
			db: db as Db,
			tenantId,
			contactId: fixture.contactId,
			conversationId: 42,
			text: "Нужен трансфер из аэропорта завтра в 10 и уборка виллы после checkout.",
		});

		expect(result.created.map((item) => item.serviceSlug).sort()).toEqual([
			"cleaning_provider",
			"transfer_provider",
		]);
		expect(result.skipped).toHaveLength(0);

		const leadRows = await withTenant(db as Db, tenantId, (tx) =>
			tx
				.select({
					id: leads.id,
					state: leads.state,
					stageDefinitionId: leads.stageDefinitionId,
					requestType: leads.requestType,
					intakeJson: leads.intakeJson,
				})
				.from(leads)
				.where(
					and(
						eq(leads.tenantId, tenantId),
						eq(leads.userId, fixture.contactId),
					),
				)
				.orderBy(asc(leads.id)),
		);
		expect(leadRows.map((lead) => lead.requestType).sort()).toEqual([
			"cleaning",
			"transfer",
		]);
		expect(
			leadRows.every((lead) => lead.stageDefinitionId === fixture.stageId),
		).toBe(true);
		expect(leadRows.every((lead) => lead.state === "awaiting_operator")).toBe(
			true,
		);
		expect(
			leadRows.every(
				(lead) =>
					JSON.parse(lead.intakeJson ?? "{}").source ===
					"service_catalog_runtime",
			),
		).toBe(true);

		const dealRows = await withTenant(db as Db, tenantId, (tx) =>
			tx.select().from(partnerDeals).where(eq(partnerDeals.tenantId, tenantId)),
		);
		expect(dealRows).toHaveLength(1);
		expect(dealRows[0]?.serviceId).toBe(fixture.transferServiceId);
		expect(dealRows[0]?.status).toBe("sent");
		expect(dealRows[0]?.handoffMode).toBe("await_callback");
		expect(dealRows[0]?.commissionPct).toBe(12);

		const transferLead = leadRows.find(
			(lead) => lead.requestType === "transfer",
		);
		if (!transferLead) throw new Error("transfer lead was not created");
		const values = await withTenant(db as Db, tenantId, (tx) =>
			tx
				.select({
					slug: stageFields.slug,
					valueJson: leadFieldValues.valueJson,
				})
				.from(leadFieldValues)
				.innerJoin(stageFields, eq(stageFields.id, leadFieldValues.fieldId))
				.where(
					and(
						eq(leadFieldValues.tenantId, tenantId),
						eq(leadFieldValues.leadId, transferLead.id),
					),
				),
		);
		const bySlug = new Map(
			values.map((value) => [value.slug, JSON.parse(value.valueJson)]),
		);
		expect(bySlug.get("route")).toBe("HKT airport -> Kata");
		expect(bySlug.get("pickup_time")).toBe("tomorrow 10:00");

		const duplicate = await runtime.extract({
			db: db as Db,
			tenantId,
			contactId: fixture.contactId,
			text: "Еще раз нужен трансфер и уборка",
		});
		expect(duplicate.created).toHaveLength(0);
		expect(duplicate.skipped.map((item) => item.reason)).toEqual([
			"open_request_exists",
			"open_request_exists",
		]);
	});
});
