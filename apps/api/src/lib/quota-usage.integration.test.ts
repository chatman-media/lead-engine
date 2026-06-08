import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutboundEnvelope } from "@chatman-media/channel-core";
import {
	applyAllMigrations,
	createIsolatedDb,
	schema,
	tryConnectToPg,
} from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import type { Mailer } from "./mailer.ts";
import { makePhotoProcessor } from "./photo-processor.ts";
import {
	canAddAdmin,
	canAddChannel,
	canAddKbDocument,
	canAddLead,
} from "./quota.ts";
import { checkUsageAlerts } from "./usage-alerts.ts";
import { UserbotOutboundDispatcher } from "./userbot-dispatcher.ts";
import { startUserbotInboundRunner } from "./userbot-inbound-runner.ts";
import { startWebInboundRunner } from "./web-inbound-runner.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_quota_usage_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
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

async function createTenant(slug: string, plan = "starter"): Promise<number> {
	const [tenant] = await db
		.insert(schema.tenants)
		.values({ slug, plan, status: "active" })
		.returning({ id: schema.tenants.id });
	if (!tenant) throw new Error("tenant insert returned no row");
	return tenant.id;
}

async function createUserbotChannel(tenantId: number, externalId: string) {
	const [channel] = await db
		.insert(schema.channels)
		.values({ tenantId, kind: "telegram_userbot", externalId })
		.returning({ id: schema.channels.id });
	if (!channel) throw new Error("channel insert returned no row");
	return channel;
}

async function enqueueOutbound(opts: {
	tenantId: number;
	channelId: number;
	payloadJson: string;
	now: number;
}) {
	const [row] = await db
		.insert(schema.outboundQueue)
		.values({
			tenantId: opts.tenantId,
			channelId: opts.channelId,
			payloadJson: opts.payloadJson,
			scheduledAt: opts.now - 1,
			createdAt: opts.now - 10,
		})
		.returning({ id: schema.outboundQueue.id });
	if (!row) throw new Error("outbound insert returned no row");
	return row;
}

async function outboundById(id: number) {
	const [row] = await db
		.select()
		.from(schema.outboundQueue)
		.where(eq(schema.outboundQueue.id, id));
	if (!row) throw new Error("outbound row not found");
	return row;
}

function dispatcherLog() {
	const errors: unknown[] = [];
	return {
		errors,
		log: {
			error: (_msg: string, ctx: unknown) => errors.push(ctx),
			warn: () => {},
			info: () => {},
			debug: () => {},
		},
	};
}

function runnerLog() {
	const errors: unknown[] = [];
	const warnings: Array<{ msg: string; ctx: unknown }> = [];
	return {
		errors,
		warnings,
		log: {
			error: (_msg: string, ctx: unknown) => errors.push(ctx),
			warn: (msg: string, ctx: unknown) => warnings.push({ msg, ctx }),
			info: () => {},
			debug: () => {},
		},
	};
}

async function* receiveOne(kind: string) {
	yield {
		channelId: kind,
		externalMessageId: String(Math.floor(Math.random() * 1_000_000)),
		externalUserId: `${kind}-user`,
		externalUsername: `${kind} user`,
		receivedAt: Math.floor(Date.now() / 1000),
		parts: [{ kind: "text" as const, text: `hello from ${kind}` }],
		raw: { kind },
	};
}

async function* noHealthEvents() {
	if (Date.now() < 0) yield { status: "connection_failed" as const };
}

async function* receiveNone() {
	if (Date.now() < 0)
		yield {
			channelId: "none",
			externalMessageId: "0",
			externalUserId: "none",
			receivedAt: 0,
			parts: [{ kind: "text" as const, text: "none" }],
			raw: {},
		};
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
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("quota helpers", () => {
	it("checks channel, KB, admin and lead limits from the tenant plan", async () => {
		if (!enabled) return;
		const tenantId = await createTenant("quota-starter");
		await db.insert(schema.channels).values([
			{ tenantId, kind: "web", externalId: "web-1" },
			{ tenantId, kind: "telegram_bot", externalId: "bot-1" },
			{ tenantId, kind: "whatsapp", externalId: "wa-1" },
		]);
		expect(await canAddChannel({ db, tenantId })).toMatchObject({
			allowed: false,
			limit: 3,
			current: 3,
			plan: "starter",
			reason: "max_channels",
		});

		expect(await canAddKbDocument({ db, tenantId })).toMatchObject({
			allowed: true,
			limit: 500,
			current: 0,
			plan: "starter",
		});

		await db.insert(schema.admins).values([
			{
				tenantId,
				email: "owner@quota.test",
				passwordHash: "hash",
				role: "superadmin",
			},
			{
				tenantId,
				email: "manager-a@quota.test",
				passwordHash: "hash",
				role: "manager",
			},
			{
				tenantId,
				email: "manager-b@quota.test",
				passwordHash: "hash",
				role: "manager",
			},
		]);
		expect(await canAddAdmin({ db, tenantId })).toMatchObject({
			allowed: false,
			limit: 3,
			current: 3,
			reason: "max_admins",
		});

		const [contact] = await db
			.insert(schema.contacts)
			.values({ tenantId, displayName: "Lead contact" })
			.returning({ id: schema.contacts.id });
		if (!contact) throw new Error("contact insert returned no row");
		await db.insert(schema.leads).values({
			tenantId,
			userId: contact.id,
			state: "intake_pending",
		});
		expect(await canAddLead({ db, tenantId })).toMatchObject({
			allowed: true,
			limit: 1000,
			current: 1,
			plan: "starter",
		});
	});

	it("treats unlimited plan limits as immediately allowed", async () => {
		if (!enabled) return;
		const tenantId = await createTenant("quota-enterprise", "enterprise");

		expect(await canAddAdmin({ db, tenantId })).toMatchObject({
			allowed: true,
			limit: -1,
			current: 0,
			plan: "enterprise",
		});
		expect(await canAddLead({ db, tenantId })).toMatchObject({
			allowed: true,
			limit: -1,
			current: 0,
			plan: "enterprise",
		});
	});
});

describe("checkUsageAlerts", () => {
	it("sends one owner email at 80% usage and dedupes repeated checks", async () => {
		if (!enabled || !sql) return;
		const tenantId = await createTenant("usage-alert-starter");
		await db.insert(schema.admins).values({
			tenantId,
			email: "owner@usage.test",
			passwordHash: "hash",
			role: "superadmin",
		});
		await sql`
			INSERT INTO llm_usage_events
				(tenant_id, purpose, provider, model, latency_ms, success, created_at)
			SELECT ${tenantId}, 'chat', 'openai', 'gpt-test', 42, TRUE,
				EXTRACT(EPOCH FROM NOW())::int
			FROM generate_series(1, 1600)
		`;

		const sent: Array<{ to: string; subject: string; html: string }> = [];
		const mailer = {
			send: async (opts: { to: string; subject: string; html: string }) => {
				sent.push(opts);
			},
		} as unknown as Mailer;

		await checkUsageAlerts(db, mailer, "https://app.example.test");
		await checkUsageAlerts(db, mailer, "https://app.example.test");

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			to: "owner@usage.test",
			subject: "Использовано 80% квоты LLM — lead-engine",
		});
		const html = sent[0]?.html.replace(/\s/g, " ");
		expect(html).toContain("1 600");
		expect(html).toContain("https://app.example.test/billing");
	});
});

describe("UserbotOutboundDispatcher", () => {
	it("claims telegram_userbot rows and marks successful sends", async () => {
		if (!enabled) return;
		const tenantId = await createTenant("dispatcher-sent");
		const channel = await createUserbotChannel(tenantId, "userbot-sent");
		const now = Math.floor(Date.now() / 1000);
		const envelope: OutboundEnvelope = {
			channelId: String(channel.id),
			externalUserId: "tg-user",
			parts: [{ kind: "text", text: "hello" }],
		};
		const queued = await enqueueOutbound({
			tenantId,
			channelId: channel.id,
			payloadJson: JSON.stringify(envelope),
			now,
		});
		const sent: OutboundEnvelope[] = [];
		const { log } = dispatcherLog();
		const dispatcher = new UserbotOutboundDispatcher(
			db,
			{
				size: () => 1,
				byChannelId: (id: number) => ({
					adapter: {
						send: async (out: OutboundEnvelope) => {
							sent.push(out);
							return {
								channelId: String(id),
								externalMessageId: "sent-1",
								sentAt: now,
							};
						},
					},
				}),
			} as never,
			{ pollMs: 1, batchSize: 10, log: log as never },
		);

		await (dispatcher as unknown as { tick(): Promise<void> }).tick();

		expect(sent).toEqual([envelope]);
		expect(await outboundById(queued.id)).toMatchObject({
			status: "sent",
			externalMessageId: "sent-1",
			attempt: 1,
		});
	});

	it("marks rows failed on registry miss, bad payload and send errors", async () => {
		if (!enabled) return;
		const tenantId = await createTenant("dispatcher-failures");
		const channel = await createUserbotChannel(tenantId, "userbot-fail");
		const now = Math.floor(Date.now() / 1000);
		const envelope: OutboundEnvelope = {
			channelId: String(channel.id),
			externalUserId: "tg-user",
			parts: [{ kind: "text", text: "hello" }],
		};

		const registryMiss = await enqueueOutbound({
			tenantId,
			channelId: channel.id,
			payloadJson: JSON.stringify(envelope),
			now,
		});
		const { log } = dispatcherLog();
		await (
			new UserbotOutboundDispatcher(
				db,
				{ size: () => 1, byChannelId: () => undefined } as never,
				{ pollMs: 1, batchSize: 10, log: log as never },
			) as unknown as { tick(): Promise<void> }
		).tick();
		expect(await outboundById(registryMiss.id)).toMatchObject({
			status: "failed",
			attempt: 1,
		});
		expect((await outboundById(registryMiss.id)).lastError).toContain(
			"userbot registry miss",
		);

		const badPayload = await enqueueOutbound({
			tenantId,
			channelId: channel.id,
			payloadJson: "{not json",
			now,
		});
		await (
			new UserbotOutboundDispatcher(
				db,
				{
					size: () => 1,
					byChannelId: () => ({ adapter: { send: async () => ({}) } }),
				} as never,
				{ pollMs: 1, batchSize: 10, log: log as never },
			) as unknown as { tick(): Promise<void> }
		).tick();
		expect(await outboundById(badPayload.id)).toMatchObject({
			status: "failed",
			attempt: 1,
		});
		expect((await outboundById(badPayload.id)).lastError).toContain(
			"invalid payload_json",
		);

		const sendError = await enqueueOutbound({
			tenantId,
			channelId: channel.id,
			payloadJson: JSON.stringify(envelope),
			now,
		});
		await (
			new UserbotOutboundDispatcher(
				db,
				{
					size: () => 1,
					byChannelId: () => ({
						adapter: {
							send: async () => {
								throw new Error("telegram down");
							},
						},
					}),
				} as never,
				{ pollMs: 1, batchSize: 10, log: log as never },
			) as unknown as { tick(): Promise<void> }
		).tick();
		expect(await outboundById(sendError.id)).toMatchObject({
			status: "failed",
			lastError: "telegram down",
			attempt: 1,
		});
	});
});

describe("inbound runners integration", () => {
	it("web runner persists one inbound and records latency", async () => {
		if (!enabled) return;
		const tenantId = await createTenant("web-runner");
		const [channel] = await db
			.insert(schema.channels)
			.values({ tenantId, kind: "web", externalId: "web-main" })
			.returning({ id: schema.channels.id });
		if (!channel) throw new Error("channel insert returned no row");
		const { log, errors } = runnerLog();
		const latencies: number[] = [];

		await startWebInboundRunner({
			entry: {
				channelDbId: channel.id,
				tenantId,
				tenantSlug: "web-runner",
				externalId: "web-main",
				adapter: { receive: () => receiveOne("web") } as never,
			},
			db,
			signal: new AbortController().signal,
			replyStrategy: {
				generate: async () => [
					{
						channelId: String(channel.id),
						externalUserId: "web-user",
						parts: [{ kind: "text", text: "web reply" }],
					},
				],
			},
			metrics: {
				inboundDeduped: { inc: () => {} },
				pipelineLatency: { observe: (v: number) => latencies.push(v) },
			} as never,
			log: log as never,
		});

		expect(errors).toHaveLength(0);
		expect(latencies.length).toBeGreaterThanOrEqual(1);
		const messages = await db
			.select()
			.from(schema.messages)
			.where(eq(schema.messages.tenantId, tenantId));
		expect(messages.map((m) => m.text)).toContain("hello from web");
		const outbound = await db
			.select()
			.from(schema.outboundQueue)
			.where(eq(schema.outboundQueue.tenantId, tenantId));
		expect(outbound).toHaveLength(1);
		expect(JSON.parse(outbound[0]?.payloadJson ?? "{}")).toMatchObject({
			externalUserId: "web-user",
			parts: [{ kind: "text", text: "web reply" }],
		});
	});

	it("userbot runner persists one inbound and handles empty health stream", async () => {
		if (!enabled) return;
		const tenantId = await createTenant("userbot-runner");
		const [channel] = await db
			.insert(schema.channels)
			.values({
				tenantId,
				kind: "telegram_userbot",
				externalId: "userbot-main",
			})
			.returning({ id: schema.channels.id });
		if (!channel) throw new Error("channel insert returned no row");
		const { log, errors } = runnerLog();
		const latencies: number[] = [];
		let photoCalls = 0;
		let fieldCalls = 0;

		await startUserbotInboundRunner({
			entry: {
				channelDbId: channel.id,
				tenantId,
				tenantSlug: "userbot-runner",
				externalId: "userbot-main",
				adapter: {
					receive: () => receiveOne("userbot"),
					healthEvents: () => noHealthEvents(),
				} as never,
			},
			db,
			signal: new AbortController().signal,
			replyStrategy: {
				generate: async () => [
					{
						channelId: String(channel.id),
						externalUserId: "userbot-user",
						parts: [{ kind: "text", text: "userbot reply" }],
					},
				],
			},
			photoProcessor: {
				process: async () => {
					photoCalls += 1;
				},
			},
			fieldExtractor: {
				extract: async () => {
					fieldCalls += 1;
				},
			},
			metrics: {
				inboundDeduped: { inc: () => {} },
				pipelineLatency: { observe: (v: number) => latencies.push(v) },
			} as never,
			log: log as never,
		});

		expect(errors).toHaveLength(0);
		expect(latencies.length).toBeGreaterThanOrEqual(1);
		const messages = await db
			.select()
			.from(schema.messages)
			.where(eq(schema.messages.tenantId, tenantId));
		expect(messages.map((m) => m.text)).toContain("hello from userbot");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(photoCalls).toBe(1);
		expect(fieldCalls).toBe(1);
		const outbound = await db
			.select()
			.from(schema.outboundQueue)
			.where(eq(schema.outboundQueue.tenantId, tenantId));
		expect(outbound).toHaveLength(1);
		expect(JSON.parse(outbound[0]?.payloadJson ?? "{}")).toMatchObject({
			externalUserId: "userbot-user",
			parts: [{ kind: "text", text: "userbot reply" }],
		});
	});

	it("userbot runner marks channel error on auth_key_duplicated health event", async () => {
		if (!enabled) return;
		const tenantId = await createTenant("userbot-health");
		const [channel] = await db
			.insert(schema.channels)
			.values({
				tenantId,
				kind: "telegram_userbot",
				externalId: "userbot-health",
			})
			.returning({ id: schema.channels.id });
		if (!channel) throw new Error("channel insert returned no row");
		const { log, errors, warnings } = runnerLog();
		let finishHealth!: () => void;
		const healthDone = new Promise<void>((resolve) => {
			finishHealth = resolve;
		});

		async function* healthEvents() {
			yield { status: "connection_failed" as const, reason: "network" };
			yield { status: "auth_key_duplicated" as const, reason: "revoked" };
			finishHealth();
		}

		await startUserbotInboundRunner({
			entry: {
				channelDbId: channel.id,
				tenantId,
				tenantSlug: "userbot-health",
				externalId: "userbot-health",
				adapter: {
					receive: () => receiveNone(),
					healthEvents,
				} as never,
			},
			db,
			signal: new AbortController().signal,
			log: log as never,
		});
		await healthDone;

		expect(errors).toHaveLength(0);
		expect(warnings.map((w) => w.msg)).toEqual([
			"userbot connection failed (transient)",
			"userbot auth revoked — marking channel error",
		]);
		const [updated] = await db
			.select({ status: schema.channels.status })
			.from(schema.channels)
			.where(eq(schema.channels.id, channel.id));
		expect(updated?.status).toBe("error");
	});
});

describe("PhotoProcessor integration", () => {
	it("classifies passport photos and merges extracted identity attributes", async () => {
		if (!enabled) return;
		const tenantId = await createTenant("photo-processor");
		const [contact] = await db
			.insert(schema.contacts)
			.values({ tenantId, displayName: "Photo contact" })
			.returning({ id: schema.contacts.id });
		if (!contact) throw new Error("contact insert returned no row");
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return Response.json({
				choices: [
					{
						message: {
							content:
								fetchCalls === 1
									? "passport"
									: '{"family_name":"IVANOVA","given_name":"ANNA","passport_number":"123456789","passport_expiry":"01.02.2030"}',
						},
					},
				],
			});
		}) as unknown as typeof fetch;
		try {
			await makePhotoProcessor({
				current: {
					byTenant: new Map([
						[
							tenantId,
							new Map([
								[
									"vision",
									{
										provider: "openrouter",
										model: "openai/gpt-4o-mini",
										apiKey: "vision-key",
										baseUrl: "https://vision.test",
										timeoutMs: 1000,
									},
								],
							]),
						],
					]),
				},
			} as never).process({
				tenantId,
				contactId: contact.id,
				db,
				inbound: {
					channelId: "telegram",
					externalMessageId: "9001",
					externalUserId: "tg-user",
					receivedAt: 1,
					parts: [
						{
							kind: "photo",
							mediaRef: { channelId: "telegram", externalRef: "file-1" },
						},
					],
					raw: {},
				},
				adapter: {
					downloadMedia: async () => new Response(new Uint8Array([1, 2, 3])),
				} as never,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}

		const [updated] = await db
			.select({ attributesJson: schema.contacts.attributesJson })
			.from(schema.contacts)
			.where(eq(schema.contacts.id, contact.id));
		expect(fetchCalls).toBe(2);
		expect(JSON.parse(updated?.attributesJson ?? "{}")).toMatchObject({
			last_photo_class: "passport",
			passport_family_name: "IVANOVA",
			passport_given_name: "ANNA",
			passport_number: "123456789",
			passport_expiry: "01.02.2030",
		});
	});
});
