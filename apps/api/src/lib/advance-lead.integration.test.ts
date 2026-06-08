/**
 * advanceLead — operator-in-the-loop продвижение лида на next_stages[0]:
 * lead.state/stage, lead_event, сообщение в чат, доставка в outbound (real-канал),
 * notify при awaiting_operator. Требует DATABASE_URL; без него — graceful-skip.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
	applyAllMigrations,
	channelIdentities,
	channels,
	contacts,
	conversations,
	createIsolatedDb,
	funnels,
	leadEvents,
	leads,
	outboundQueue,
	partnerDeals,
	partnerServices,
	partners,
	schema,
	stageDefinitions,
	tenants,
	tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { advanceLead } from "./advance-lead.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_advlead_${Math.random().toString(36).slice(2, 10)}`;
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
let enabled = false;
let n = 0;
let tenantId = 0;
let funnelId = 0;
let intakeId = 0;
let qualifyId = 0;
let opId = 0;
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

interface StagePartnerOpts {
	partnerWebhookUrl?: string | null;
	partnerWebhookMode?: "fire_and_forget" | "await_callback";
}

function requireRow<T>(row: T | undefined, label: string): T {
	if (!row) throw new Error(`${label} was not created`);
	return row;
}

async function makeStage(
	funnelId: number,
	slug: string,
	kind: string,
	stageType: string,
	position: number,
	nextStages: string[],
	partnerOpts: StagePartnerOpts = {},
) {
	const [s] = await db
		.insert(stageDefinitions)
		.values({
			tenantId,
			funnelId,
			slug,
			displayName: slug,
			kind,
			stageType,
			position,
			nextStages,
			partnerWebhookUrl: partnerOpts.partnerWebhookUrl ?? null,
			partnerWebhookMode: partnerOpts.partnerWebhookMode ?? "fire_and_forget",
			createdAt: n,
			updatedAt: n,
		})
		.returning({ id: stageDefinitions.id });
	return requireRow(s, "stage").id;
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
	n = Math.floor(Date.now() / 1000);
	const [t] = await db
		.insert(tenants)
		.values({ slug: `advlead-${n}`, status: "active" })
		.returning({ id: tenants.id });
	tenantId = requireRow(t, "tenant").id;
	const [f] = await db
		.insert(funnels)
		.values({
			tenantId,
			slug: "main",
			isActive: true,
			createdAt: n,
			updatedAt: n,
		})
		.returning({ id: funnels.id });
	funnelId = requireRow(f, "funnel").id;
	intakeId = await makeStage(funnelId, "intake", "intake", "form_fill", 0, [
		"qualify",
	]);
	qualifyId = await makeStage(funnelId, "qualify", "active", "form_fill", 1, [
		"op",
	]);
	opId = await makeStage(funnelId, "op", "active", "awaiting_operator", 2, []);
}, 30_000);

afterEach(() => {
	globalThis.fetch = originalFetch;
	console.error = originalConsoleError;
});

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

async function makeLead(
	stageId: number,
	state: string,
	opts: { intakeJson?: string } = {},
): Promise<{ leadId: number; contactId: number }> {
	const [c] = await db
		.insert(contacts)
		.values({
			tenantId,
			displayName: `c-${Math.random().toString(36).slice(2, 8)}`,
			createdAt: n,
		})
		.returning({ id: contacts.id });
	const [l] = await db
		.insert(leads)
		.values({
			tenantId,
			userId: requireRow(c, "contact").id,
			state,
			stageDefinitionId: stageId,
			intakeJson: opts.intakeJson ?? "{}",
			createdAt: n,
			updatedAt: n,
		})
		.returning({ id: leads.id });
	return {
		leadId: requireRow(l, "lead").id,
		contactId: requireRow(c, "contact").id,
	};
}

async function makePartnerFixture(
	opts: {
		webhookMode?: "fire_and_forget" | "await_callback";
		webhookUrl?: string;
		commissionPct?: number;
		withService?: boolean;
		intakeJson?: string;
	} = {},
) {
	const suffix = Math.random().toString(36).slice(2, 8);
	const sourceSlug = `partner_source_${suffix}`;
	const partnerSlug = `partner_wait_${suffix}`;
	const sourceId = await makeStage(
		funnelId,
		sourceSlug,
		"active",
		"form_fill",
		30,
		[partnerSlug],
	);
	const partnerStageId = await makeStage(
		funnelId,
		partnerSlug,
		"active",
		"external_approval",
		31,
		[],
		{
			partnerWebhookUrl: opts.webhookUrl ?? "https://partner.test/handoff",
			partnerWebhookMode: opts.webhookMode ?? "await_callback",
		},
	);
	const { leadId, contactId } = await makeLead(sourceId, sourceSlug, {
		intakeJson: opts.intakeJson,
	});

	let partnerId: number | null = null;
	let serviceId: number | null = null;
	if (opts.withService !== false) {
		const [partner] = await db
			.insert(partners)
			.values({
				tenantId,
				name: `partner-${suffix}`,
				status: "active",
				defaultCommissionPct: 3,
				settlementCurrency: "THB",
				createdAt: n,
				updatedAt: n,
			})
			.returning({ id: partners.id });
		const partnerRow = requireRow(partner, "partner");
		partnerId = partnerRow.id;
		const [service] = await db
			.insert(partnerServices)
			.values({
				tenantId,
				partnerId: partnerRow.id,
				name: `service-${suffix}`,
				category: "visa",
				funnelId,
				stageDefinitionId: partnerStageId,
				commissionPct: opts.commissionPct ?? 7,
				isActive: true,
				createdAt: n,
				updatedAt: n,
			})
			.returning({ id: partnerServices.id });
		serviceId = requireRow(service, "partner service").id;
	}

	return {
		sourceId,
		sourceSlug,
		partnerStageId,
		partnerSlug,
		leadId,
		contactId,
		partnerId,
		serviceId,
	};
}

describe("advanceLead", () => {
	it("несуществующий лид → no_lead", async () => {
		if (!enabled) return;
		const r = await advanceLead({
			db,
			tenantId,
			selector: { leadId: 9999999 },
		});
		expect(r.kind).toBe("no_lead");
	});

	it("терминальная стадия (нет nextStages) → terminal", async () => {
		if (!enabled) return;
		const { leadId } = await makeLead(opId, "op");
		const r = await advanceLead({ db, tenantId, selector: { leadId } });
		expect(r.kind).toBe("terminal");
	});

	it("happy: intake → qualify, lead обновлён + lead_event", async () => {
		if (!enabled) return;
		const { leadId } = await makeLead(intakeId, "intake");
		const r = await advanceLead({ db, tenantId, selector: { leadId } });
		expect(r.kind).toBe("advanced");
		if (r.kind !== "advanced") return;
		expect(r.from).toBe("intake");
		expect(r.to).toBe("qualify");
		const [lead] = await db
			.select({ state: leads.state, stage: leads.stageDefinitionId })
			.from(leads)
			.where(eq(leads.id, leadId));
		expect(lead?.state).toBe("qualify");
		expect(lead?.stage).toBe(qualifyId);
		const evs = await db
			.select({ toState: leadEvents.toState, notes: leadEvents.notes })
			.from(leadEvents)
			.where(
				and(eq(leadEvents.tenantId, tenantId), eq(leadEvents.leadId, leadId)),
			);
		expect(evs.some((e) => e.toState === "qualify")).toBe(true);
		expect(
			evs.some((e) => e.notes?.includes('"workflowEvent":"operator_advanced"')),
		).toBe(true);
	});

	it("с диалогом + активным каналом → сообщение в чат + outbound доставка", async () => {
		if (!enabled) return;
		const { leadId, contactId } = await makeLead(intakeId, "intake");
		const [ch] = await db
			.insert(channels)
			.values({
				tenantId,
				kind: "telegram_bot",
				externalId: `b-${n}-${leadId}`,
				status: "active",
				createdAt: n,
				updatedAt: n,
			})
			.returning({ id: channels.id });
		const channel = requireRow(ch, "channel");
		await db.insert(channelIdentities).values({
			contactId,
			channelId: channel.id,
			externalUserId: `tg-${leadId}`,
			createdAt: n,
		});
		await db.insert(conversations).values({
			tenantId,
			userId: contactId,
			source: "bot",
			mode: "ai",
			lastMessageAt: n,
			createdAt: n,
		});

		const r = await advanceLead({
			db,
			tenantId,
			selector: { contactId },
			note: "Переходим дальше!",
		});
		expect(r.kind).toBe("advanced");
		const queued = await db
			.select({ payload: outboundQueue.payloadJson })
			.from(outboundQueue)
			.where(eq(outboundQueue.tenantId, tenantId));
		expect(queued.some((q) => q.payload.includes("Переходим дальше"))).toBe(
			true,
		);
	});

	it("self_play диалог → НЕ доставляется в outbound", async () => {
		if (!enabled) return;
		const { leadId, contactId } = await makeLead(intakeId, "intake");
		await db.insert(conversations).values({
			tenantId,
			userId: contactId,
			source: "self_play",
			mode: "ai",
			lastMessageAt: n,
			createdAt: n,
		});
		const before = (
			await db
				.select({ id: outboundQueue.id })
				.from(outboundQueue)
				.where(eq(outboundQueue.tenantId, tenantId))
		).length;
		const r = await advanceLead({ db, tenantId, selector: { leadId } });
		expect(r.kind).toBe("advanced");
		const after = (
			await db
				.select({ id: outboundQueue.id })
				.from(outboundQueue)
				.where(eq(outboundQueue.tenantId, tenantId))
		).length;
		expect(after).toBe(before); // ничего не добавилось
	});

	it("вход в awaiting_operator → notify operator_confirm_needed", async () => {
		if (!enabled) return;
		const { leadId } = await makeLead(qualifyId, "qualify");
		const events: Array<{ eventType: string; leadId?: number }> = [];
		const r = await advanceLead({
			db,
			tenantId,
			selector: { leadId },
			notifications: {
				notify: async (e: { eventType: string; leadId?: number }) => {
					events.push(e);
				},
			} as never,
		});
		expect(r.kind).toBe("advanced");
		if (r.kind === "advanced") expect(r.awaitingOperator).toBe(true);
		expect(
			events.some(
				(e) => e.eventType === "operator_confirm_needed" && e.leadId === leadId,
			),
		).toBe(true);
	});

	it("partner stage → создаёт deal, отправляет ping и сохраняет callback token", async () => {
		if (!enabled) return;
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (url, init) => {
			calls.push({ url: String(url), init });
			return new Response("ok", { status: 200 });
		}) as typeof fetch;
		const fixture = await makePartnerFixture({
			webhookMode: "await_callback",
			commissionPct: 12.5,
			intakeJson: JSON.stringify({ service: "transfer", amountThb: 2000 }),
		});

		const r = await advanceLead({
			db,
			tenantId,
			selector: { leadId: fixture.leadId },
			partnerPing: {
				appUrl: "https://app.test",
				operatorBotToken: "bot-token",
				callbackSecret: "partner-secret",
			},
		});

		expect(r.kind).toBe("advanced");
		if (r.kind !== "advanced") return;
		expect(r.to).toBe(fixture.partnerSlug);
		expect(r.awaitingPartner).toBe(true);
		const [deal] = await db
			.select({
				partnerId: partnerDeals.partnerId,
				serviceId: partnerDeals.serviceId,
				status: partnerDeals.status,
				handoffUrl: partnerDeals.handoffUrl,
				handoffMode: partnerDeals.handoffMode,
				commissionPct: partnerDeals.commissionPct,
			})
			.from(partnerDeals)
			.where(
				and(
					eq(partnerDeals.tenantId, tenantId),
					eq(partnerDeals.leadId, fixture.leadId),
				),
			);
		expect(deal).toEqual({
			partnerId: fixture.partnerId,
			serviceId: fixture.serviceId,
			status: "sent",
			handoffUrl: "https://partner.test/handoff",
			handoffMode: "await_callback",
			commissionPct: 12.5,
		});
		const [lead] = await db
			.select({
				state: leads.state,
				stage: leads.stageDefinitionId,
				awaitingToken: leads.awaitingToken,
			})
			.from(leads)
			.where(eq(leads.id, fixture.leadId));
		expect(lead?.state).toBe(fixture.partnerSlug);
		expect(lead?.stage).toBe(fixture.partnerStageId);
		const awaitingToken = lead?.awaitingToken;
		expect(typeof awaitingToken).toBe("string");
		if (!awaitingToken) throw new Error("awaiting token was not stored");
		expect(calls).toHaveLength(1);
		const call = calls.at(0);
		if (!call) throw new Error("partner ping was not called");
		expect(call.url).toBe("https://partner.test/handoff");
		const body = JSON.parse(String(call.init?.body)) as {
			event: string;
			tenantSlug: string;
			stage: { slug: string; displayName: string };
			contact: { displayName: string | null };
			fields: Record<string, unknown>;
			callbackToken: string;
			actions: { confirm: string; cancel: string };
		};
		expect(body.event).toBe("lead.partner_handoff");
		expect(body.tenantSlug).toStartWith("advlead-");
		expect(body.stage.slug).toBe(fixture.partnerSlug);
		expect(typeof body.contact.displayName).toBe("string");
		expect(body.fields.service).toBe("transfer");
		expect(body.callbackToken).toBe(awaitingToken);
		expect(body.actions.confirm).toBe(
			`https://app.test/api/partner/cb/${awaitingToken}?a=confirm`,
		);
		expect(body.actions.cancel).toBe(
			`https://app.test/api/partner/cb/${awaitingToken}?a=cancel`,
		);
	});

	it("partner stage без service использует нулевую комиссию и переживает битый intakeJson", async () => {
		if (!enabled) return;
		const calls: Array<{ body: Record<string, unknown> }> = [];
		globalThis.fetch = (async (_url, init) => {
			calls.push({
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			});
			return new Response("ok", { status: 200 });
		}) as typeof fetch;
		const fixture = await makePartnerFixture({
			webhookMode: "fire_and_forget",
			withService: false,
			intakeJson: "{broken",
		});

		const r = await advanceLead({
			db,
			tenantId,
			selector: { leadId: fixture.leadId },
			partnerPing: {
				appUrl: "https://app.test",
				operatorBotToken: "bot-token",
				callbackSecret: "partner-secret",
			},
		});

		expect(r.kind).toBe("advanced");
		if (r.kind === "advanced") expect(r.awaitingPartner).toBe(false);
		const [deal] = await db
			.select({
				partnerId: partnerDeals.partnerId,
				serviceId: partnerDeals.serviceId,
				handoffMode: partnerDeals.handoffMode,
				commissionPct: partnerDeals.commissionPct,
			})
			.from(partnerDeals)
			.where(
				and(
					eq(partnerDeals.tenantId, tenantId),
					eq(partnerDeals.leadId, fixture.leadId),
				),
			);
		expect(deal).toEqual({
			partnerId: null,
			serviceId: null,
			handoffMode: "fire_and_forget",
			commissionPct: 0,
		});
		const [lead] = await db
			.select({ awaitingToken: leads.awaitingToken })
			.from(leads)
			.where(eq(leads.id, fixture.leadId));
		expect(lead?.awaitingToken).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body.fields).toEqual({});
	});

	it("ошибка partner ping не откатывает продвижение лида", async () => {
		if (!enabled) return;
		const errors: unknown[][] = [];
		globalThis.fetch = (async () =>
			new Response("partner down", { status: 503 })) as unknown as typeof fetch;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		const fixture = await makePartnerFixture({
			webhookMode: "await_callback",
			withService: false,
		});

		const r = await advanceLead({
			db,
			tenantId,
			selector: { leadId: fixture.leadId },
			partnerPing: {
				appUrl: "https://app.test",
				operatorBotToken: "bot-token",
				callbackSecret: "partner-secret",
			},
		});

		expect(r.kind).toBe("advanced");
		if (r.kind !== "advanced") return;
		expect(r.to).toBe(fixture.partnerSlug);
		expect(r.awaitingPartner).toBe(true);
		const [lead] = await db
			.select({
				state: leads.state,
				stage: leads.stageDefinitionId,
				awaitingToken: leads.awaitingToken,
			})
			.from(leads)
			.where(eq(leads.id, fixture.leadId));
		expect(lead).toEqual({
			state: fixture.partnerSlug,
			stage: fixture.partnerStageId,
			awaitingToken: null,
		});
		const [deal] = await db
			.select({
				status: partnerDeals.status,
				handoffMode: partnerDeals.handoffMode,
			})
			.from(partnerDeals)
			.where(
				and(
					eq(partnerDeals.tenantId, tenantId),
					eq(partnerDeals.leadId, fixture.leadId),
				),
			);
		expect(deal).toEqual({ status: "sent", handoffMode: "await_callback" });
		expect(errors.some((args) => args[0] === "[partner-ping] failed")).toBe(
			true,
		);
	});
});
