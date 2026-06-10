/**
 * Conversation channel identity coverage for BPR-2. Uses an isolated DB so the
 * migration-level unique indexes are exercised, not only the in-memory testkit.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { ConversationsRepo } from "./conversations.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_conv_channel_${Math.random().toString(36).slice(2, 10)}`;
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
let enabled = false;
let tenantId = 0;
let contactId = 0;
let telegramChannelId = 0;
let whatsappChannelId = 0;
let webChannelId = 0;
let now = 0;

const repo = () => new ConversationsRepo({ db, tenantId });

function must<T>(value: T | undefined, label: string): T {
	if (!value) throw new Error(`${label} insert returned no row`);
	return value;
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
	now = Math.floor(Date.parse("2026-06-10T00:00:00Z") / 1000);

	const tenant = must(
		(
			await db
				.insert(schema.tenants)
				.values({ slug: `conv-channel-${now}`, status: "active" })
				.returning({ id: schema.tenants.id })
		)[0],
		"tenant",
	);
	tenantId = tenant.id;

	const contact = must(
		(
			await db
				.insert(schema.contacts)
				.values({ tenantId, displayName: "Channel Contact", createdAt: now })
				.returning({ id: schema.contacts.id })
		)[0],
		"contact",
	);
	contactId = contact.id;

	const channelRows = await db
		.insert(schema.channels)
		.values([
			{
				tenantId,
				kind: "telegram_bot",
				externalId: "bot-main",
				createdAt: now,
			},
			{
				tenantId,
				kind: "whatsapp",
				externalId: "wa-main",
				createdAt: now,
			},
			{ tenantId, kind: "web", externalId: "web-main", createdAt: now },
		])
		.returning({ id: schema.channels.id, kind: schema.channels.kind });
	telegramChannelId = must(
		channelRows.find((row) => row.kind === "telegram_bot"),
		"telegram channel",
	).id;
	whatsappChannelId = must(
		channelRows.find((row) => row.kind === "whatsapp"),
		"whatsapp channel",
	).id;
	webChannelId = must(
		channelRows.find((row) => row.kind === "web"),
		"web channel",
	).id;
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("ConversationsRepo channel identity", () => {
	it("allows separate source=bot conversations for different real channels", async () => {
		if (!enabled) return;
		const telegram = await repo().create({
			contactId,
			channelId: telegramChannelId,
			source: "bot",
			nowEpoch: now,
		});
		const whatsapp = await repo().create({
			contactId,
			channelId: whatsappChannelId,
			source: "bot",
			nowEpoch: now + 1,
		});
		const web = await repo().create({
			contactId,
			channelId: webChannelId,
			source: "bot",
			nowEpoch: now + 2,
		});

		expect(new Set([telegram.id, whatsapp.id, web.id]).size).toBe(3);
		expect(
			(await repo().findByContactAndChannel(contactId, whatsappChannelId))?.id,
		).toBe(whatsapp.id);
		expect(
			(await repo().findByContactAndChannel(contactId, webChannelId))?.id,
		).toBe(web.id);
		expect(await repo().findByContactAndSource(contactId, "bot")).toBeNull();
	});

	it("keeps legacy source uniqueness only for channel_id=NULL rows", async () => {
		if (!enabled) return;
		const legacyContact = must(
			(
				await db
					.insert(schema.contacts)
					.values({
						tenantId,
						displayName: "Legacy Source Contact",
						createdAt: now,
					})
					.returning({ id: schema.contacts.id })
			)[0],
			"legacy contact",
		);
		const legacy = await repo().create({
			contactId: legacyContact.id,
			source: "bot",
			nowEpoch: now,
		});

		expect(legacy.channelId).toBeNull();
		expect(
			(await repo().findByContactAndSource(legacyContact.id, "bot"))?.id,
		).toBe(legacy.id);
		await expect(
			repo().create({
				contactId: legacyContact.id,
				source: "bot",
				nowEpoch: now + 1,
			}),
		).rejects.toThrow();
	});
});
