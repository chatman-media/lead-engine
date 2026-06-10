/**
 * OutboundQueueRepo: enqueue (+идемпотентность), claimPending (limit/kinds/
 * scheduled_at), markSent/markFailed, releaseStuckProcessing. Требует
 * DATABASE_URL; без него — graceful-skip.
 */

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
import { OutboundQueueRepo } from "./outbound.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_outq_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"storage",
	"migrations",
);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let channelId = 0;
let enabled = false;
let now = 0;

const repo = () => new OutboundQueueRepo({ db, tenantId });
const env = (idem?: string): OutboundEnvelope =>
	({
		kind: "text",
		text: "hi",
		...(idem ? { idempotencyKey: idem } : {}),
	}) as unknown as OutboundEnvelope;

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
	now = Math.floor(Date.now() / 1000);
	const [t] = await db
		.insert(schema.tenants)
		.values({ slug: `outq-${now}` })
		.returning({ id: schema.tenants.id });
	tenantId = t!.id;
	const [c] = await db
		.insert(schema.channels)
		.values({ tenantId, kind: "telegram_bot", externalId: `bot-${now}` })
		.returning({ id: schema.channels.id });
	channelId = c!.id;
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("OutboundQueueRepo", () => {
	it("enqueue → pending row", async () => {
		if (!enabled) return;
		const row = await repo().enqueue({
			channelId,
			envelope: env(),
			nowEpoch: now,
		});
		expect(row.status).toBe("pending");
		expect(row.channelId).toBe(channelId);
	});

	it("enqueue идемпотентен по idempotencyKey (без дубля)", async () => {
		if (!enabled) return;
		const a = await repo().enqueue({
			channelId,
			envelope: env("idem-1"),
			nowEpoch: now,
		});
		const b = await repo().enqueue({
			channelId,
			envelope: env("idem-1"),
			nowEpoch: now,
		});
		expect(b.id).toBe(a.id);
		const all = await db
			.select()
			.from(schema.outboundQueue)
			.where(eq(schema.outboundQueue.idempotencyKey, "idem-1"));
		expect(all.length).toBe(1);
	});

	it("claimPending переводит pending→processing и уважает limit", async () => {
		if (!enabled) return;
		await repo().enqueue({ channelId, envelope: env("c-a"), nowEpoch: now });
		await repo().enqueue({ channelId, envelope: env("c-b"), nowEpoch: now });
		const claimed = await repo().claimPending({ limit: 1, nowEpoch: now });
		expect(claimed.length).toBe(1);
		expect(claimed[0]!.status).toBe("processing");
	});

	it("claimPending не берёт строки из будущего (scheduled_at > now)", async () => {
		if (!enabled) return;
		await repo().enqueue({
			channelId,
			envelope: env("future"),
			scheduledAt: now + 10_000,
			nowEpoch: now,
		});
		const claimed = await repo().claimPending({ limit: 50, nowEpoch: now });
		expect(
			claimed.find((r) => r.payloadJson.includes("future")),
		).toBeUndefined();
	});

	it("claimPending с kinds-фильтром пропускает чужой kind", async () => {
		if (!enabled) return;
		await repo().enqueue({ channelId, envelope: env("kf"), nowEpoch: now });
		const claimed = await repo().claimPending({
			limit: 50,
			nowEpoch: now,
			kinds: ["whatsapp"],
		});
		expect(claimed.find((r) => r.payloadJson.includes('"kf"'))).toBeUndefined();
	});

	it("markSent → status sent + externalMessageId + attempt++", async () => {
		if (!enabled) return;
		const row = await repo().enqueue({
			channelId,
			envelope: env("sent"),
			nowEpoch: now,
		});
		await repo().markSent(row.id, "ext-123", now);
		const [after] = await db
			.select()
			.from(schema.outboundQueue)
			.where(eq(schema.outboundQueue.id, row.id));
		expect(after?.status).toBe("sent");
		expect(after?.externalMessageId).toBe("ext-123");
		expect(after?.attempt).toBe(1);
	});

	it("markFailed → status failed + lastError + attempt++", async () => {
		if (!enabled) return;
		const row = await repo().enqueue({
			channelId,
			envelope: env("fail"),
			nowEpoch: now,
		});
		await repo().markFailed(row.id, "boom");
		const [after] = await db
			.select()
			.from(schema.outboundQueue)
			.where(eq(schema.outboundQueue.id, row.id));
		expect(after?.status).toBe("failed");
		expect(after?.lastError).toBe("boom");
	});

	it("releaseStuckProcessing возвращает зависшие processing в pending", async () => {
		if (!enabled) return;
		// строка из прошлого, заклеймленная → processing
		await repo().enqueue({
			channelId,
			envelope: env("stuck"),
			scheduledAt: now - 1000,
			nowEpoch: now - 1000,
		});
		await repo().claimPending({ limit: 50, nowEpoch: now });
		const released = await repo().releaseStuckProcessing({
			nowEpoch: now,
			stuckSec: 60,
		});
		expect(released).toBeGreaterThanOrEqual(1);
	});
});
