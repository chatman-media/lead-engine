import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
	applyAllMigrations,
	contacts,
	createIsolatedDb,
	funnels,
	leadEvents,
	leads,
	partnerDeals,
	schema,
	stageDefinitions,
	tenants,
	tryConnectToPg,
} from "@chatman-media/storage";
import { desc, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { makeCallbackToken } from "../lib/partner-ping.ts";
import { makePartnerCallbackRoutes } from "./webhook-partner-callback.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_partner_cb_${Math.random().toString(36).slice(2, 10)}`;
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
const CALLBACK_SECRET = "test-secret-partner-callback-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;

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
	app.route(
		"/",
		makePartnerCallbackRoutes({
			db,
			callbackSecret: CALLBACK_SECRET,
			appUrl: "https://app.test",
		}),
	);
}, 30_000);

afterAll(async () => {
	if (sql) {
		await sql.end({ timeout: 0 }).catch(() => {});
		sql = null;
	}
}, 10_000);

describe("partner callback route", () => {
	it("renders landing page and confirm advances through workflow runtime", async () => {
		if (!sql) return;
		const fixture = await createCallbackFixture("confirm");

		const landing = await app.request(`/api/partner/cb/${fixture.token}`);
		expect(landing.status).toBe(200);
		expect(await landing.text()).toContain("Партнёрская заявка");

		const confirm = await app.request(
			`/api/partner/cb/${fixture.token}?a=confirm`,
		);
		expect(confirm.status).toBe(200);
		expect(await confirm.text()).toContain("Done");

		const [lead] = await db
			.select({
				state: leads.state,
				stageDefinitionId: leads.stageDefinitionId,
				awaitingToken: leads.awaitingToken,
			})
			.from(leads)
			.where(eq(leads.id, fixture.leadId));
		expect(lead).toEqual({
			state: "done",
			stageDefinitionId: fixture.doneStageId,
			awaitingToken: null,
		});

		const [deal] = await db
			.select({
				status: partnerDeals.status,
				acceptedAt: partnerDeals.acceptedAt,
			})
			.from(partnerDeals)
			.where(eq(partnerDeals.leadId, fixture.leadId));
		expect(deal?.status).toBe("accepted");
		expect(deal?.acceptedAt).toBeTruthy();

		const [event] = await db
			.select({ fromState: leadEvents.fromState, toState: leadEvents.toState, notes: leadEvents.notes })
			.from(leadEvents)
			.where(eq(leadEvents.leadId, fixture.leadId))
			.orderBy(desc(leadEvents.id))
			.limit(1);
		expect(event?.fromState).toBe("partner_wait");
		expect(event?.toState).toBe("done");
		expect(event?.notes).toContain('"workflowEvent":"webhook_callback"');
		expect(event?.notes).toContain('"callbackAction":"confirm"');

		const repeat = await app.request(
			`/api/partner/cb/${fixture.token}?a=confirm`,
		);
		expect(await repeat.text()).toContain("Уже обработано");
	});

	it("cancel clears token, rejects deal, and records callback event without advancing", async () => {
		if (!sql) return;
		const fixture = await createCallbackFixture("cancel");

		const cancel = await app.request(
			`/api/partner/cb/${fixture.token}?a=cancel`,
		);
		expect(cancel.status).toBe(200);
		expect(await cancel.text()).toContain("Отклонено");

		const [lead] = await db
			.select({
				state: leads.state,
				stageDefinitionId: leads.stageDefinitionId,
				awaitingToken: leads.awaitingToken,
				rejectedReason: leads.rejectedReason,
			})
			.from(leads)
			.where(eq(leads.id, fixture.leadId));
		expect(lead).toEqual({
			state: "partner_wait",
			stageDefinitionId: fixture.partnerStageId,
			awaitingToken: null,
			rejectedReason: "Партнёр отклонил заявку.",
		});

		const [deal] = await db
			.select({
				status: partnerDeals.status,
				cancelledAt: partnerDeals.cancelledAt,
			})
			.from(partnerDeals)
			.where(eq(partnerDeals.leadId, fixture.leadId));
		expect(deal?.status).toBe("rejected");
		expect(deal?.cancelledAt).toBeTruthy();

		const [event] = await db
			.select({ fromState: leadEvents.fromState, toState: leadEvents.toState, notes: leadEvents.notes })
			.from(leadEvents)
			.where(eq(leadEvents.leadId, fixture.leadId))
			.orderBy(desc(leadEvents.id))
			.limit(1);
		expect(event?.fromState).toBe("partner_wait");
		expect(event?.toState).toBe("partner_wait");
		expect(event?.notes).toContain('"workflowEvent":"webhook_callback"');
		expect(event?.notes).toContain('"callbackAction":"cancel"');
	});
});

async function createCallbackFixture(label: string): Promise<{
	tenantId: number;
	leadId: number;
	partnerStageId: number;
	doneStageId: number;
	token: string;
}> {
	const now = Math.floor(Date.now() / 1000);
	const [tenant] = await db
		.insert(tenants)
		.values({
			slug: `partner-cb-${label}-${Math.random().toString(36).slice(2, 7)}`,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: tenants.id });
	if (!tenant) throw new Error("tenant was not created");

	const [contact] = await db
		.insert(contacts)
		.values({
			tenantId: tenant.id,
			displayName: `Partner Callback ${label}`,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: contacts.id });
	if (!contact) throw new Error("contact was not created");

	const [funnel] = await db
		.insert(funnels)
		.values({
			tenantId: tenant.id,
			slug: `partner-callback-${label}`,
			isActive: true,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: funnels.id });
	if (!funnel) throw new Error("funnel was not created");

	const [partnerStage] = await db
		.insert(stageDefinitions)
		.values({
			tenantId: tenant.id,
			funnelId: funnel.id,
			slug: "partner_wait",
			displayName: "Partner Wait",
			kind: "active",
			stageType: "external_approval",
			phase: "clear",
			position: 1,
			nextStages: ["done"],
			partnerWebhookUrl: "https://partner.test/handoff",
			partnerWebhookMode: "await_callback",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: stageDefinitions.id });
	if (!partnerStage) throw new Error("partner stage was not created");

	const [doneStage] = await db
		.insert(stageDefinitions)
		.values({
			tenantId: tenant.id,
			funnelId: funnel.id,
			slug: "done",
			displayName: "Done",
			kind: "terminal_won",
			stageType: "milestone",
			position: 2,
			nextStages: [],
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: stageDefinitions.id });
	if (!doneStage) throw new Error("done stage was not created");

	const [lead] = await db
		.insert(leads)
		.values({
			tenantId: tenant.id,
			userId: contact.id,
			state: "partner_wait",
			stageDefinitionId: partnerStage.id,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: leads.id });
	if (!lead) throw new Error("lead was not created");

	const token = await makeCallbackToken(
		{
			tenantId: tenant.id,
			leadId: lead.id,
			stageId: partnerStage.id,
			ts: now,
		},
		CALLBACK_SECRET,
	);

	await db
		.update(leads)
		.set({ awaitingToken: token, updatedAt: now })
		.where(eq(leads.id, lead.id));

	await db.insert(partnerDeals).values({
		tenantId: tenant.id,
		leadId: lead.id,
		stageDefinitionId: partnerStage.id,
		status: "sent",
		handoffUrl: "https://partner.test/handoff",
		handoffMode: "await_callback",
		sentAt: now,
		createdAt: now,
		updatedAt: now,
	});

	return {
		tenantId: tenant.id,
		leadId: lead.id,
		partnerStageId: partnerStage.id,
		doneStageId: doneStage.id,
		token,
	};
}
