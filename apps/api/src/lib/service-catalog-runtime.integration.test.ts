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
import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { makeAuthRoutes } from "../routes/auth.ts";
import {
	deterministicCatalogMatches,
	extractInboundText,
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
	transferSlug: string;
	cleaningSlug: string;
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
		const suffix = Math.random().toString(36).slice(2, 8);
		const transferSlug = `transfer_provider_${suffix}`;
		const cleaningSlug = `cleaning_provider_${suffix}`;
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
				slug: transferSlug,
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
				slug: cleaningSlug,
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
			transferSlug,
			cleaningSlug,
		};
	});
}

describe("service catalog runtime", () => {
	it("extractInboundText combines text and captions", () => {
		expect(
			extractInboundText({
				channelId: "telegram",
				externalUserId: "u1",
				externalMessageId: "m1",
				parts: [
					{ kind: "text", text: "Нужен трансфер" },
					{
						kind: "photo",
						mediaRef: { channelId: "telegram", externalRef: "file-id" },
						caption: "из аэропорта завтра",
					},
				],
				receivedAt: 1,
				raw: {},
			}),
		).toBe("Нужен трансфер\nиз аэропорта завтра");
		expect(
			extractInboundText({
				channelId: "telegram",
				externalUserId: "u1",
				externalMessageId: "m2",
				parts: [
					{
						kind: "photo",
						mediaRef: { channelId: "telegram", externalRef: "file-id-2" },
					},
				],
				receivedAt: 1,
				raw: {},
			}),
		).toBe("");
	});

	it("returns empty result for blank text and tenants without active catalog", async () => {
		if (!sql) return;
		const [blankContact] = await withTenant(db as Db, tenantId, (tx) =>
			tx
				.insert(contacts)
				.values({
					tenantId,
					displayName: "Blank Text",
					createdAt: 1_800_000_000,
					updatedAt: 1_800_000_000,
				})
				.returning({ id: contacts.id }),
		);
		const runtime = makeServiceCatalogRuntime();
		await expect(
			runtime.extract({
				db: db as Db,
				tenantId,
				contactId: expectInserted(blankContact, "blank contact").id,
				text: "   ",
			}),
		).resolves.toEqual({ created: [], skipped: [] });

		const app = new Hono();
		// biome-ignore lint/suspicious/noExplicitAny: Drizzle generic in test harness
		app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
		const res = await app.request("/api/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: `service-runtime-empty-${Date.now()}@demo.io`,
				password: "strong-pwd-12345",
			}),
		});
		const body = (await res.json()) as { admin: { tenantId: number } };
		const emptyTenantId = body.admin.tenantId;
		const [contact] = await withTenant(db as Db, emptyTenantId, (tx) =>
			tx
				.insert(contacts)
				.values({
					tenantId: emptyTenantId,
					displayName: "No Catalog",
					createdAt: 1_800_000_000,
					updatedAt: 1_800_000_000,
				})
				.returning({ id: contacts.id }),
		);
		await expect(
			runtime.extract({
				db: db as Db,
				tenantId: emptyTenantId,
				contactId: expectInserted(contact, "empty tenant contact").id,
				text: "нужен трансфер",
			}),
		).resolves.toEqual({ created: [], skipped: [] });
	});

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

	it("dedupes catalog matches by request type and ignores generic tokens", () => {
		const matches = deterministicCatalogMatches("нужен водитель в аэропорт", [
			{
				id: 1,
				slug: "transfer_main",
				name: "Трансфер",
				category: "service",
			},
			{
				id: 2,
				slug: "transfer_backup",
				name: "Airport pickup",
				category: "provider",
			},
			{
				id: 3,
				slug: "generic_service",
				name: "Custom service provider",
				category: "services",
			},
		]);

		expect(matches).toHaveLength(1);
		expect(matches[0]?.requestType).toBe("transfer");
		expect(matches[0]?.serviceSlug).toBe("transfer_main");
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
									slug: fixture.transferSlug,
									confidence: 0.99,
									fields: {
										route: "HKT airport -> Kata",
										pickup_time: "tomorrow 10:00",
									},
								},
								{
									slug: fixture.cleaningSlug,
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
			fixture.cleaningSlug,
			fixture.transferSlug,
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

	it("uses LLM JSON embedded in text, display-name field mapping, and webhook handoff", async () => {
		if (!sql) return;
		const fixture = await seedFixture();
		await withTenant(db as Db, tenantId, async (tx) => {
			await tx.insert(serviceCatalogItems).values({
				tenantId,
				slug: "cleaning_webhook",
				name: "Webhook cleaning",
				category: "Уборка",
				routeType: "webhook",
				webhookUrl: "https://hooks.example.test/service",
				metadataJson: JSON.stringify({
					requiredFields: ["Route", "Pickup time"],
				}),
				isActive: true,
				sortOrder: 5,
				createdAt: 1_800_000_000,
				updatedAt: 1_800_000_000,
			});
		});
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const runtime = makeServiceCatalogRuntime({
			now: () => 1_800_000_200,
			fetch: (async (url: string | URL | Request, init?: RequestInit) => {
				calls.push({
					url: String(url),
					body: JSON.parse(String(init?.body ?? "{}")) as Record<
						string,
						unknown
					>,
				});
				return new Response("ok");
			}) as typeof fetch,
			resolveChat: () =>
				({
					complete: async () =>
						`Ответ:\n${JSON.stringify({
							requests: [
								{
									slug: "cleaning_webhook",
									confidence: 0.9,
									fields: {
										Route: "Villa 7",
										"Pickup time": "today 15:00",
										unknown: "ignored",
									},
									note: "urgent".repeat(120),
								},
							],
						})}`,
				}) as never,
		});

		const result = await runtime.extract({
			db: db as Db,
			tenantId,
			contactId: fixture.contactId,
			conversationId: 777,
			text: "нужна уборка сегодня",
			inbound: {
				channelId: "telegram",
				externalUserId: "u1",
				externalMessageId: "msg-777",
				parts: [{ kind: "text", text: "нужна уборка сегодня" }],
				receivedAt: 1_800_000_199,
				raw: { update_id: 777 },
			},
		});

		expect(result.created).toHaveLength(1);
		expect(result.created[0]?.routeType).toBe("webhook");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://hooks.example.test/service");
		expect(calls[0]?.body).toMatchObject({
			event: "service_request.created",
			tenantId,
			contactId: fixture.contactId,
			conversationId: 777,
			requestType: "cleaning",
			service: {
				slug: "cleaning_webhook",
				category: "Уборка",
			},
		});

		const [createdLead] = await withTenant(db as Db, tenantId, (tx) =>
			tx
				.select({ id: leads.id, intakeJson: leads.intakeJson })
				.from(leads)
				.where(
					and(
						eq(leads.tenantId, tenantId),
						eq(leads.userId, fixture.contactId),
						eq(leads.requestType, "cleaning"),
					),
				)
				.orderBy(desc(leads.id))
				.limit(1),
		);
		const webhookLead = expectInserted(createdLead, "webhook lead");
		expect(JSON.parse(webhookLead.intakeJson ?? "{}")).toMatchObject({
			externalMessageId: "msg-777",
			conversationId: 777,
			matchSource: "llm",
		});
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
						eq(leadFieldValues.leadId, webhookLead.id),
					),
				),
		);
		const bySlug = new Map(
			values.map((value) => [value.slug, JSON.parse(value.valueJson)]),
		);
		expect(bySlug.get("route")).toBe("Villa 7");
		expect(bySlug.get("pickup_time")).toBe("today 15:00");
		expect([...bySlug.keys()]).not.toContain("unknown");
	});

	it("routes funnel services to the first stage of the configured funnel", async () => {
		if (!sql) return;
		const fixture = await seedFixture();
		const now = 1_800_000_300;
		const [targetFunnel] = await withTenant(db as Db, tenantId, async (tx) => {
			const [funnel] = await tx
				.insert(funnels)
				.values({
					tenantId,
					slug: `visa_${Math.random().toString(36).slice(2, 8)}`,
					stagesJson: "[]",
					isActive: true,
					createdAt: now,
					updatedAt: now,
				})
				.returning({ id: funnels.id });
			if (!funnel) throw new Error("funnel insert failed");
			await tx.insert(stageDefinitions).values({
				tenantId,
				funnelId: funnel.id,
				slug: "visa_intake",
				displayName: "Visa intake",
				position: 0,
				kind: "intake",
				stageType: "form_fill",
				nextStages: [],
				createdAt: now,
				updatedAt: now,
			});
			await tx.insert(serviceCatalogItems).values({
				tenantId,
				slug: "visa_service",
				name: "Visa service",
				category: "Visa",
				routeType: "funnel",
				funnelId: funnel.id,
				metadataJson: "{}",
				isActive: true,
				sortOrder: 1,
				createdAt: now,
				updatedAt: now,
			});
			return [{ id: funnel.id }];
		});

		const runtime = makeServiceCatalogRuntime({
			now: () => now + 1,
			resolveChat: () =>
				({
					complete: async () =>
						JSON.stringify({
							requests: [{ slug: "visa_service", confidence: 0.99 }],
						}),
				}) as never,
		});
		const result = await runtime.extract({
			db: db as Db,
			tenantId,
			contactId: fixture.contactId,
			text: "нужна помощь с визой",
		});

		expect(result.created).toHaveLength(1);
		expect(result.created[0]?.serviceSlug).toBe("visa_service");
		const [lead] = await withTenant(db as Db, tenantId, (tx) =>
			tx
				.select({
					state: leads.state,
					stageDefinitionId: leads.stageDefinitionId,
				})
				.from(leads)
				.innerJoin(
					stageDefinitions,
					eq(stageDefinitions.id, leads.stageDefinitionId),
				)
				.where(
					and(
						eq(leads.tenantId, tenantId),
						eq(leads.userId, fixture.contactId),
						eq(stageDefinitions.funnelId, targetFunnel.id),
					),
				)
				.limit(1),
		);
		expect(lead?.state).toBe("visa_intake");
		expect(lead?.stageDefinitionId).toBeGreaterThan(0);
	});

	it("uses partner service stage target before partner funnel fallback", async () => {
		if (!sql) return;
		const fixture = await seedFixture();
		const now = 1_800_000_500;
		const suffix = Math.random().toString(36).slice(2, 8);
		const setup = await withTenant(db as Db, tenantId, async (tx) => {
			const [partner] = await tx
				.insert(partners)
				.values({
					tenantId,
					name: `Coverage Partner ${suffix}`,
					status: "active",
					defaultCommissionPct: 8,
					createdAt: now,
					updatedAt: now,
				})
				.returning({ id: partners.id });
			const partnerRow = expectInserted(partner, "partner");

			const [stageFunnel] = await tx
				.insert(funnels)
				.values({
					tenantId,
					slug: `stage_target_${suffix}`,
					stagesJson: "[]",
					isActive: true,
					createdAt: now,
					updatedAt: now,
				})
				.returning({ id: funnels.id });
			const stageFunnelRow = expectInserted(stageFunnel, "stage target funnel");
			const [directStage] = await tx
				.insert(stageDefinitions)
				.values({
					tenantId,
					funnelId: stageFunnelRow.id,
					slug: `partner_stage_${suffix}`,
					displayName: "Partner stage target",
					position: 1,
					kind: "active",
					stageType: "external_approval",
					phase: "offer",
					nextStages: [],
					createdAt: now,
					updatedAt: now,
				})
				.returning({ id: stageDefinitions.id, slug: stageDefinitions.slug });
			const directStageRow = expectInserted(directStage, "direct stage");

			const [fallbackFunnel] = await tx
				.insert(funnels)
				.values({
					tenantId,
					slug: `funnel_target_${suffix}`,
					stagesJson: "[]",
					isActive: true,
					createdAt: now,
					updatedAt: now,
				})
				.returning({ id: funnels.id });
			const fallbackFunnelRow = expectInserted(
				fallbackFunnel,
				"fallback funnel",
			);
			const [fallbackStage] = await tx
				.insert(stageDefinitions)
				.values({
					tenantId,
					funnelId: fallbackFunnelRow.id,
					slug: `partner_funnel_${suffix}`,
					displayName: "Partner funnel target",
					position: 1,
					kind: "active",
					stageType: "awaiting_operator",
					phase: "offer",
					nextStages: [],
					createdAt: now,
					updatedAt: now,
				})
				.returning({ id: stageDefinitions.id, slug: stageDefinitions.slug });
			const fallbackStageRow = expectInserted(fallbackStage, "fallback stage");

			const [stageService] = await tx
				.insert(partnerServices)
				.values({
					tenantId,
					partnerId: partnerRow.id,
					name: `Massage approval ${suffix}`,
					category: "Massage",
					stageDefinitionId: directStageRow.id,
					commissionPct: 5,
					notes: JSON.stringify({
						handoffUrl: "https://partners.example.test/stage",
					}),
					createdAt: now,
					updatedAt: now,
				})
				.returning({ id: partnerServices.id });
			const stageServiceRow = expectInserted(stageService, "stage service");
			const [funnelService] = await tx
				.insert(partnerServices)
				.values({
					tenantId,
					partnerId: partnerRow.id,
					name: `Chef dinner ${suffix}`,
					category: "Food",
					funnelId: fallbackFunnelRow.id,
					commissionPct: 6,
					createdAt: now,
					updatedAt: now,
				})
				.returning({ id: partnerServices.id });
			const funnelServiceRow = expectInserted(funnelService, "funnel service");

			await tx.insert(serviceCatalogItems).values([
				{
					tenantId,
					slug: `massage_stage_${suffix}`,
					name: "Массаж с подтверждением",
					category: "Massage",
					routeType: "partner_service",
					partnerServiceId: stageServiceRow.id,
					metadataJson: "{}",
					isActive: true,
					sortOrder: 1,
					createdAt: now,
					updatedAt: now,
				},
				{
					tenantId,
					slug: `chef_dinner_${suffix}`,
					name: "Шеф ужин",
					category: "Food",
					routeType: "partner_service",
					partnerServiceId: funnelServiceRow.id,
					metadataJson: "{}",
					isActive: true,
					sortOrder: 2,
					createdAt: now,
					updatedAt: now,
				},
			]);

			return {
				stageSlug: `massage_stage_${suffix}`,
				funnelSlug: `chef_dinner_${suffix}`,
				directStageId: directStageRow.id,
				directStageSlug: directStageRow.slug,
				fallbackStageId: fallbackStageRow.id,
				fallbackStageSlug: fallbackStageRow.slug,
			};
		});
		const runtime = makeServiceCatalogRuntime({
			now: () => now + 1,
			resolveChat: () =>
				({
					complete: async () =>
						JSON.stringify({
							requests: [
								{ slug: setup.stageSlug, confidence: 0.99 },
								{ slug: setup.funnelSlug, confidence: 0.99 },
							],
						}),
				}) as never,
		});

		const result = await runtime.extract({
			db: db as Db,
			tenantId,
			contactId: fixture.contactId,
			text: "нужен массаж и ужин с шефом",
		});

		expect(result.created.map((item) => item.serviceSlug).sort()).toEqual([
			setup.funnelSlug,
			setup.stageSlug,
		]);
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
				),
		);
		const bySlug = new Map(
			leadRows.map((lead) => [
				JSON.parse(lead.intakeJson ?? "{}").serviceSlug as string,
				lead,
			]),
		);
		expect(bySlug.get(setup.stageSlug)).toMatchObject({
			state: setup.directStageSlug,
			stageDefinitionId: setup.directStageId,
			requestType: "massage",
		});
		expect(bySlug.get(setup.funnelSlug)).toMatchObject({
			state: setup.fallbackStageSlug,
			stageDefinitionId: setup.fallbackStageId,
			requestType: "food",
		});

		const stageLead = expectInserted(
			bySlug.get(setup.stageSlug),
			"stage target lead",
		);
		const [deal] = await withTenant(db as Db, tenantId, (tx) =>
			tx
				.select({
					handoffUrl: partnerDeals.handoffUrl,
					handoffMode: partnerDeals.handoffMode,
				})
				.from(partnerDeals)
				.where(eq(partnerDeals.leadId, stageLead.id))
				.limit(1),
		);
		expect(deal).toMatchObject({
			handoffUrl: "https://partners.example.test/stage",
			handoffMode: "fire_and_forget",
		});
	});

	it("falls back to heuristic when LLM fails and to synthetic state without stages", async () => {
		if (!sql) return;
		const app = new Hono();
		// biome-ignore lint/suspicious/noExplicitAny: Drizzle generic in test harness
		app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
		const res = await app.request("/api/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: `service-runtime-synthetic-${Date.now()}@demo.io`,
				password: "strong-pwd-12345",
			}),
		});
		const body = (await res.json()) as { admin: { tenantId: number } };
		const syntheticTenantId = body.admin.tenantId;
		const [contact] = await withTenant(
			db as Db,
			syntheticTenantId,
			async (tx) => {
				const [insertedContact] = await tx
					.insert(contacts)
					.values({
						tenantId: syntheticTenantId,
						displayName: "Synthetic Stage",
						createdAt: 1_800_000_400,
						updatedAt: 1_800_000_400,
					})
					.returning({ id: contacts.id });
				await tx.insert(serviceCatalogItems).values({
					tenantId: syntheticTenantId,
					slug: "airport-transfer-long-slug",
					name: "Airport transfer",
					category: "Transfer",
					routeType: "manual",
					metadataJson: "not-json",
					isActive: true,
					sortOrder: 1,
					createdAt: 1_800_000_400,
					updatedAt: 1_800_000_400,
				});
				return [expectInserted(insertedContact, "synthetic contact")];
			},
		);
		const runtime = makeServiceCatalogRuntime({
			now: () => 1_800_000_401,
			resolveChat: () =>
				({
					complete: async () => {
						throw new Error("llm down");
					},
				}) as never,
		});

		const result = await runtime.extract({
			db: db as Db,
			tenantId: syntheticTenantId,
			contactId: contact.id,
			text: "нужен водитель в аэропорт",
		});
		expect(result.created).toHaveLength(1);
		expect(result.created[0]?.serviceSlug).toBe("airport-transfer-long-slug");
		const [lead] = await withTenant(db as Db, syntheticTenantId, (tx) =>
			tx
				.select({
					state: leads.state,
					stageDefinitionId: leads.stageDefinitionId,
					requestType: leads.requestType,
				})
				.from(leads)
				.where(eq(leads.tenantId, syntheticTenantId))
				.limit(1),
		);
		expect(lead).toMatchObject({
			state: "service_airport-transfer-long-slug",
			stageDefinitionId: null,
			requestType: "transfer",
		});
	});

	it("LLM вернул мусор с фигурными скобками → heuristic fallback", async () => {
		if (!sql) return;
		const app = new Hono();
		// biome-ignore lint/suspicious/noExplicitAny: Drizzle generic in test harness
		app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
		const res = await app.request("/api/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: `service-runtime-garbage-${Date.now()}@demo.io`,
				password: "strong-pwd-12345",
			}),
		});
		const body = (await res.json()) as { admin: { tenantId: number } };
		const garbageTenantId = body.admin.tenantId;
		const [contact] = await withTenant(db as Db, garbageTenantId, async (tx) => {
			const [insertedContact] = await tx
				.insert(contacts)
				.values({
					tenantId: garbageTenantId,
					displayName: "Garbage LLM",
					createdAt: 1_800_000_600,
					updatedAt: 1_800_000_600,
				})
				.returning({ id: contacts.id });
			await tx.insert(serviceCatalogItems).values({
				tenantId: garbageTenantId,
				slug: "garbage_transfer",
				name: "Трансфер из аэропорта",
				category: "Трансфер",
				routeType: "manual",
				metadataJson: "{}",
				isActive: true,
				sortOrder: 1,
				createdAt: 1_800_000_600,
				updatedAt: 1_800_000_600,
			});
			return [expectInserted(insertedContact, "garbage llm contact")];
		});
		const runtime = makeServiceCatalogRuntime({
			now: () => 1_800_000_601,
			resolveChat: () =>
				({
					// Прямой JSON.parse падает (префикс), вложенный {…} тоже не JSON →
					// parseJsonObject отдаёт null, матчи берутся из эвристики.
					complete: async () => "Ответ модели: {oops, not: json}",
				}) as never,
		});
		const result = await runtime.extract({
			db: db as Db,
			tenantId: garbageTenantId,
			contactId: contact.id,
			text: "нужен трансфер из аэропорта",
		});
		expect(result.created.map((item) => item.serviceSlug)).toEqual([
			"garbage_transfer",
		]);
		expect(result.created[0]?.routeType).toBe("manual");
	});

	it("неизвестный route_type фильтруется при загрузке каталога", async () => {
		if (!sql) return;
		const app = new Hono();
		// biome-ignore lint/suspicious/noExplicitAny: Drizzle generic in test harness
		app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
		const res = await app.request("/api/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: `service-runtime-badroute-${Date.now()}@demo.io`,
				password: "strong-pwd-12345",
			}),
		});
		const body = (await res.json()) as { admin: { tenantId: number } };
		const badRouteTenantId = body.admin.tenantId;
		// Снимаем CHECK в изолированной тест-БД, чтобы смоделировать
		// legacy/будущее значение route_type, которое рантайм должен игнорировать.
		if (!sql) return;
		await sql`ALTER TABLE service_catalog_items DROP CONSTRAINT IF EXISTS service_catalog_route_type_check`;
		const [contact] = await withTenant(db as Db, badRouteTenantId, async (tx) => {
			const [insertedContact] = await tx
				.insert(contacts)
				.values({
					tenantId: badRouteTenantId,
					displayName: "Bad Route",
					createdAt: 1_800_000_700,
					updatedAt: 1_800_000_700,
				})
				.returning({ id: contacts.id });
			await tx.insert(serviceCatalogItems).values({
				tenantId: badRouteTenantId,
				slug: "mystery_transfer",
				name: "Трансфер призрак",
				category: "Трансфер",
				routeType: "mystery",
				metadataJson: "{}",
				isActive: true,
				sortOrder: 1,
				createdAt: 1_800_000_700,
				updatedAt: 1_800_000_700,
			});
			return [expectInserted(insertedContact, "bad route contact")];
		});

		const runtime = makeServiceCatalogRuntime({ now: () => 1_800_000_701 });
		// Единственный item отфильтрован по route_type → каталог пуст → no-op.
		await expect(
			runtime.extract({
				db: db as Db,
				tenantId: badRouteTenantId,
				contactId: contact.id,
				text: "нужен трансфер в аэропорт",
			}),
		).resolves.toEqual({ created: [], skipped: [] });
	});
});
