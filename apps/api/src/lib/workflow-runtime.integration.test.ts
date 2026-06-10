import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
	applyAllMigrations,
	contacts,
	createIsolatedDb,
	customerRequests,
	funnels,
	leadFieldValues,
	leads,
	schema,
	stageDefinitions,
	stageFields,
	tenants,
	tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { autoAdvanceLead } from "./workflow-runtime.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_workflow_rt_${Math.random().toString(36).slice(2, 10)}`;
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

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let funnelId = 0;
let now = 0;

function must<T>(value: T | null | undefined, message: string): T {
	if (!value) throw new Error(message);
	return value;
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

	now = Math.floor(Date.now() / 1000);
	const [tenant] = await db
		.insert(tenants)
		.values({ slug: `workflow-rt-${now}`, status: "active" })
		.returning({ id: tenants.id });
	tenantId = must(tenant, "tenant insert returned no row").id;
	const [funnel] = await db
		.insert(funnels)
		.values({
			tenantId,
			slug: "workflow_runtime",
			isActive: true,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: funnels.id });
	funnelId = must(funnel, "funnel insert returned no row").id;
}, 30_000);

afterAll(async () => {
	if (sql) {
		await sql.end({ timeout: 0 }).catch(() => {});
		sql = null;
	}
}, 10_000);

async function leadAtStage(
	stageId: number,
	state: string,
	opts: { requestType?: string } = {},
): Promise<number> {
	const [contact] = await db
		.insert(contacts)
		.values({
			tenantId,
			displayName: `rt-${Math.random().toString(36).slice(2, 8)}`,
			createdAt: now,
		})
		.returning({ id: contacts.id });
	const contactId = must(contact, "contact insert returned no row").id;
	const [lead] = await db
		.insert(leads)
		.values({
			tenantId,
			userId: contactId,
			state,
			stageDefinitionId: stageId,
			requestType: opts.requestType ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: leads.id });
	return must(lead, "lead insert returned no row").id;
}

describe("autoAdvanceLead workflow runtime", () => {
	it("returns awaitingOperator metadata when entering awaiting_operator stage", async () => {
		if (!sql) return;
		const [intake] = await db
			.insert(stageDefinitions)
			.values({
				tenantId,
				funnelId,
				slug: "op_intake",
				displayName: "Operator Intake",
				kind: "intake",
				stageType: "form_fill",
				position: 10,
				nextStages: ["operator_offer"],
				autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: stageDefinitions.id });
		await db.insert(stageDefinitions).values({
			tenantId,
			funnelId,
			slug: "operator_offer",
			displayName: "Operator Offer",
			kind: "active",
			stageType: "awaiting_operator",
			phase: "offer",
			position: 11,
			nextStages: [],
			createdAt: now,
			updatedAt: now,
		});
		const [field] = await db
			.insert(stageFields)
			.values({
				tenantId,
				stageId: must(intake, "op_intake insert returned no row").id,
				slug: "need",
				displayName: "Need",
				fieldType: "text",
				required: true,
				position: 0,
				createdAt: now,
			})
			.returning({ id: stageFields.id });
		const leadId = await leadAtStage(
			must(intake, "op_intake insert returned no row").id,
			"op_intake",
		);
		await db.insert(leadFieldValues).values({
			tenantId,
			leadId,
			fieldId: must(field, "field insert returned no row").id,
			valueJson: '"filled"',
			updatedAt: now,
		});

		const result = await autoAdvanceLead({
			db,
			tenantId,
			leadId,
			eventType: "message_received",
			now,
		});

		expect(result).toMatchObject({
			advanced: true,
			to: "operator_offer",
			awaitingOperator: true,
			awaitingPartner: false,
		});
	});

	it("returns awaitingPartner metadata when entering await_callback partner stage", async () => {
		if (!sql) return;
		const [intake] = await db
			.insert(stageDefinitions)
			.values({
				tenantId,
				funnelId,
				slug: "partner_intake",
				displayName: "Partner Intake",
				kind: "intake",
				stageType: "form_fill",
				position: 20,
				nextStages: ["partner_waiting"],
				autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: stageDefinitions.id });
		await db.insert(stageDefinitions).values({
			tenantId,
			funnelId,
			slug: "partner_waiting",
			displayName: "Partner Waiting",
			kind: "active",
			stageType: "form_fill",
			phase: "offer",
			position: 21,
			nextStages: [],
			partnerWebhookUrl: "https://partner.example/hook",
			partnerWebhookMode: "await_callback",
			createdAt: now,
			updatedAt: now,
		});
		const [field] = await db
			.insert(stageFields)
			.values({
				tenantId,
				stageId: must(intake, "partner_intake insert returned no row").id,
				slug: "need",
				displayName: "Need",
				fieldType: "text",
				required: true,
				position: 0,
				createdAt: now,
			})
			.returning({ id: stageFields.id });
		const leadId = await leadAtStage(
			must(intake, "partner_intake insert returned no row").id,
			"partner_intake",
		);
		await db.insert(leadFieldValues).values({
			tenantId,
			leadId,
			fieldId: must(field, "field insert returned no row").id,
			valueJson: '"filled"',
			updatedAt: now,
		});

		const result = await autoAdvanceLead({
			db,
			tenantId,
			leadId,
			eventType: "field_updated",
			now,
		});

		expect(result).toMatchObject({
			advanced: true,
			to: "partner_waiting",
			awaitingOperator: false,
			awaitingPartner: true,
		});
		const [lead] = await db
			.select({ state: leads.state })
			.from(leads)
			.where(eq(leads.id, leadId));
		expect(must(lead, "lead missing").state).toBe("partner_waiting");
	});

	it("syncs customer_requests status when request lead reaches terminal", async () => {
		if (!sql) return;
		const [active] = await db
			.insert(stageDefinitions)
			.values({
				tenantId,
				funnelId,
				slug: "food_offer",
				displayName: "Food Offer",
				kind: "active",
				stageType: "form_fill",
				phase: "offer",
				position: 30,
				nextStages: ["food_won"],
				autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: stageDefinitions.id });
		const [won] = await db
			.insert(stageDefinitions)
			.values({
				tenantId,
				funnelId,
				slug: "food_won",
				displayName: "Food Won",
				kind: "terminal_won",
				stageType: "milestone",
				position: 31,
				nextStages: [],
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: stageDefinitions.id });
		const [field] = await db
			.insert(stageFields)
			.values({
				tenantId,
				stageId: must(active, "food_offer insert returned no row").id,
				slug: "confirmed",
				displayName: "Confirmed",
				fieldType: "boolean",
				required: true,
				position: 0,
				createdAt: now,
			})
			.returning({ id: stageFields.id });
		const leadId = await leadAtStage(
			must(active, "food_offer insert returned no row").id,
			"food_offer",
			{
				requestType: "food",
			},
		);
		await db.insert(leadFieldValues).values({
			tenantId,
			leadId,
			fieldId: must(field, "field insert returned no row").id,
			valueJson: "true",
			updatedAt: now,
		});

		const result = await autoAdvanceLead({
			db,
			tenantId,
			leadId,
			eventType: "field_updated",
			now: now + 1,
		});
		expect(result).toMatchObject({
			advanced: true,
			to: "food_won",
			terminal: true,
		});
		const [request] = await db
			.select()
			.from(customerRequests)
			.where(
				and(
					eq(customerRequests.tenantId, tenantId),
					eq(customerRequests.leadId, leadId),
				),
			);
		expect(request?.requestType).toBe("food");
		expect(request?.status).toBe("won");
		expect(request?.stageDefinitionId).toBe(won?.id);
		expect(request?.closedAt).toBe(now + 1);
	});
});
