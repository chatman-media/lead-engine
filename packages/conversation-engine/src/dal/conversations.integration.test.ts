/**
 * ConversationsRepo — CRUD + inbox-метаданные (unread / status / assignee /
 * summary) + tenant-изоляция. Требует DATABASE_URL; без него — graceful-skip.
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
const dbName = `lead_engine_conv_${Math.random().toString(36).slice(2, 10)}`;
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
let n = 0;
let t1 = 0;
let t2 = 0;
let contact1 = 0;

const repo = () => new ConversationsRepo({ db, tenantId: t1 });

function returnedId(row: { id: number } | undefined, label: string): number {
	if (!row) throw new Error(`${label} insert returned no row`);
	return row.id;
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
	const [a] = await db
		.insert(schema.tenants)
		.values({ slug: `conv-a-${n}` })
		.returning({ id: schema.tenants.id });
	const [b] = await db
		.insert(schema.tenants)
		.values({ slug: `conv-b-${n}` })
		.returning({ id: schema.tenants.id });
	t1 = returnedId(a, "tenant a");
	t2 = returnedId(b, "tenant b");
	const [c] = await db
		.insert(schema.contacts)
		.values({ tenantId: t1, displayName: "Conv Contact", createdAt: n })
		.returning({ id: schema.contacts.id });
	contact1 = returnedId(c, "contact");
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

// Свежий контакт под каждый тест: UNIQUE (tenant, user, source) + source-check
// (bot|userbot|self_play) не дают переиспользовать один контакт многократно.
async function freshContact(): Promise<number> {
	const [c] = await db
		.insert(schema.contacts)
		.values({
			tenantId: t1,
			displayName: `c-${Math.random().toString(36).slice(2, 8)}`,
			createdAt: n,
		})
		.returning({ id: schema.contacts.id });
	return returnedId(c, "fresh contact");
}

async function freshChannel(
	kind: "telegram_bot" | "whatsapp" | "web",
): Promise<number> {
	const [c] = await db
		.insert(schema.channels)
		.values({
			tenantId: t1,
			kind,
			externalId: `${kind}-${Math.random().toString(36).slice(2, 8)}`,
			status: "active",
			createdAt: n,
			updatedAt: n,
		})
		.returning({ id: schema.channels.id });
	if (!c) throw new Error("channel insert returned no row");
	return c.id;
}

describe("ConversationsRepo", () => {
	it("create → строка с дефолтами; findById находит; чужой tenant — нет", async () => {
		if (!enabled) return;
		const conv = await repo().create({
			contactId: contact1,
			source: "bot",
			nowEpoch: n,
		});
		expect(conv.id).toBeGreaterThan(0);
		expect(conv.source).toBe("bot");
		expect((await repo().findById(conv.id))?.id).toBe(conv.id);
		// изоляция
		expect(
			await new ConversationsRepo({ db, tenantId: t2 }).findById(conv.id),
		).toBeNull();
	});

	it("create c mode/styleId/experimentId", async () => {
		if (!enabled) return;
		const conv = await repo().create({
			contactId: await freshContact(),
			source: "userbot",
			mode: "human",
			styleId: null,
			experimentId: null,
			nowEpoch: n,
		});
		expect(conv.mode).toBe("human");
	});

	it("findByContactAndSource", async () => {
		if (!enabled) return;
		const found = await repo().findByContactAndSource(contact1, "bot");
		expect(found?.source).toBe("bot");
		expect(
			await repo().findByContactAndSource(contact1, "self_play"),
		).toBeNull();
	});

	it("channelId keeps bot-sourced channels as separate conversations", async () => {
		if (!enabled) return;
		const contactId = await freshContact();
		const telegramChannelId = await freshChannel("telegram_bot");
		const whatsappChannelId = await freshChannel("whatsapp");
		const webChannelId = await freshChannel("web");

		const tg = await repo().create({
			contactId,
			channelId: telegramChannelId,
			source: "bot",
			nowEpoch: n,
		});
		const wa = await repo().create({
			contactId,
			channelId: whatsappChannelId,
			source: "bot",
			nowEpoch: n + 1,
		});
		const web = await repo().create({
			contactId,
			channelId: webChannelId,
			source: "bot",
			nowEpoch: n + 2,
		});

		expect(new Set([tg.id, wa.id, web.id]).size).toBe(3);
		expect(
			(await repo().findByContactAndChannel(contactId, whatsappChannelId))?.id,
		).toBe(wa.id);
		expect(await repo().findByContactAndSource(contactId, "bot")).toBeNull();
	});

	it("touchLastMessageAt обновляет таймстамп", async () => {
		if (!enabled) return;
		const conv = await repo().create({
			contactId: await freshContact(),
			source: "bot",
			nowEpoch: n,
		});
		await repo().touchLastMessageAt(conv.id, n + 500);
		expect((await repo().findById(conv.id))?.lastMessageAt).toBe(n + 500);
	});

	it("updateInboxMetadata: text + status + incrementUnread", async () => {
		if (!enabled) return;
		const conv = await repo().create({
			contactId: await freshContact(),
			source: "bot",
			nowEpoch: n,
		});
		await repo().updateInboxMetadata(conv.id, {
			lastMessageText: "привет",
			lastMessageAt: n + 10,
			status: "pending",
			incrementUnread: true,
		});
		await repo().updateInboxMetadata(conv.id, { incrementUnread: true });
		const row = await repo().findById(conv.id);
		expect(row?.lastMessageText).toBe("привет");
		expect(row?.status).toBe("pending");
		expect(row?.unreadCount).toBe(2);
	});

	it("markAsRead обнуляет unreadCount", async () => {
		if (!enabled) return;
		const conv = await repo().create({
			contactId: await freshContact(),
			source: "bot",
			nowEpoch: n,
		});
		await repo().updateInboxMetadata(conv.id, { incrementUnread: true });
		await repo().markAsRead(conv.id);
		expect((await repo().findById(conv.id))?.unreadCount).toBe(0);
	});

	it("setAssignee / setSummaryJson", async () => {
		if (!enabled) return;
		const conv = await repo().create({
			contactId: await freshContact(),
			source: "bot",
			nowEpoch: n,
		});
		await repo().setAssignee(conv.id, 42);
		await repo().setSummaryJson(conv.id, '{"summary":"x"}');
		const row = await repo().findById(conv.id);
		expect(row?.assignedAdminId).toBe(42);
		expect(row?.summaryJson).toBe('{"summary":"x"}');
		// снять ассайн
		await repo().setAssignee(conv.id, null);
		expect((await repo().findById(conv.id))?.assignedAdminId).toBeNull();
	});

	it("setAssignment сохраняет styleId/experimentId tenant-scoped", async () => {
		if (!enabled) return;
		const [style] = await db
			.insert(schema.styles)
			.values({
				tenantId: t1,
				slug: `conv-style-${Math.random().toString(36).slice(2, 8)}`,
				displayName: "Conversation Style",
				configJson: "{}",
				isActive: true,
				version: 1,
				createdAt: n,
			})
			.returning({ id: schema.styles.id });
		const [experiment] = await db
			.insert(schema.experiments)
			.values({
				tenantId: t1,
				slug: `conv-exp-${Math.random().toString(36).slice(2, 8)}`,
				status: "running",
				allocationJson: "[]",
				successMetric: "won",
				createdAt: n,
			})
			.returning({ id: schema.experiments.id });
		if (!style || !experiment)
			throw new Error("expected style and experiment rows");
		const conv = await repo().create({
			contactId: await freshContact(),
			source: "bot",
			nowEpoch: n,
		});

		await new ConversationsRepo({ db, tenantId: t2 }).setAssignment(conv.id, {
			styleId: style.id,
			experimentId: experiment.id,
		});
		expect((await repo().findById(conv.id))?.styleId).toBeNull();

		await repo().setAssignment(conv.id, {
			styleId: style.id,
			experimentId: experiment.id,
		});

		const row = await repo().findById(conv.id);
		expect(row?.styleId).toBe(style.id);
		expect(row?.experimentId).toBe(experiment.id);
	});

	it("recent → DESC by last_message_at, ограничено limit", async () => {
		if (!enabled) return;
		const rows = await repo().recent(3);
		expect(rows.length).toBeLessThanOrEqual(3);
		for (let i = 0; i < rows.length - 1; i++) {
			const current = rows[i];
			const next = rows[i + 1];
			if (!current || !next) throw new Error("recent returned sparse rows");
			const a = current.lastMessageAt ?? 0;
			const b = next.lastMessageAt ?? 0;
			expect(a).toBeGreaterThanOrEqual(b);
		}
	});
});
