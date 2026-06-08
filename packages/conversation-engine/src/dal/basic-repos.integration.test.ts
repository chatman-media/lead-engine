/**
 * Integration coverage for small DAL repos that are usually exercised through
 * higher-level flows. One isolated DB covers contacts, leads, messages and
 * skill outcomes without adding separate migration setup per repo.
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
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { ContactsRepo } from "./contacts.ts";
import { LeadsRepo } from "./leads.ts";
import { MessagesRepo } from "./messages.ts";
import { SkillOutcomesRepo } from "./skill-outcomes.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_dal_basic_${Math.random().toString(36).slice(2, 10)}`;
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
let otherTenantId = 0;
let now = 0;

const contactsRepo = () => new ContactsRepo({ db, tenantId });
const leadsRepo = () => new LeadsRepo({ db, tenantId });
const messagesRepo = () => new MessagesRepo({ db, tenantId });
const outcomesRepo = () => new SkillOutcomesRepo({ db, tenantId });

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
	now = Math.floor(Date.parse("2026-06-06T00:00:00Z") / 1000);

	const [tenant] = await db
		.insert(schema.tenants)
		.values({ slug: `dal-basic-${now}`, status: "active" })
		.returning({ id: schema.tenants.id });
	const [other] = await db
		.insert(schema.tenants)
		.values({ slug: `dal-basic-other-${now}`, status: "active" })
		.returning({ id: schema.tenants.id });
	if (!tenant || !other) throw new Error("tenant inserts returned no rows");
	tenantId = tenant.id;
	otherTenantId = other.id;
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("ContactsRepo", () => {
	it("create/byId/mergeAttributes respect tenant scope and merge shallow JSON", async () => {
		if (!enabled) return;
		const contact = await contactsRepo().create({
			displayName: "Alice",
			attributesJson: JSON.stringify({ city: "Bangkok", prefs: { old: true } }),
		});
		expect(contact.displayName).toBe("Alice");
		expect((await contactsRepo().byId(contact.id))?.id).toBe(contact.id);
		expect(
			await new ContactsRepo({ db, tenantId: otherTenantId }).byId(contact.id),
		).toBeNull();

		const noOp = await contactsRepo().mergeAttributes(contact.id, {}, now + 1);
		expect(noOp?.attributesJson).toBe(contact.attributesJson);

		const merged = await contactsRepo().mergeAttributes(
			contact.id,
			{ city: "Phuket", tier: "vip" },
			now + 2,
		);
		if (!merged?.attributesJson) {
			throw new Error("mergeAttributes did not return attributes");
		}
		expect(JSON.parse(merged.attributesJson)).toEqual({
			city: "Phuket",
			prefs: { old: true },
			tier: "vip",
		});
		expect(
			await contactsRepo().mergeAttributes(
				999_999,
				{ city: "Nowhere" },
				now + 3,
			),
		).toBeNull();
	});
});

describe("LeadsRepo", () => {
	it("create/find/update covers contact and request_type selectors", async () => {
		if (!enabled) return;
		const contact = await contactsRepo().create({
			displayName: "Lead contact",
		});
		const transfer = await leadsRepo().create({
			contactId: contact.id,
			state: "transfer_request",
			requestType: "transfer",
			nowEpoch: now,
		});
		const food = await leadsRepo().create({
			contactId: contact.id,
			state: "food_request",
			requestType: "food",
			nowEpoch: now + 10,
		});

		expect((await leadsRepo().byId(transfer.id))?.state).toBe(
			"transfer_request",
		);
		expect(
			await new LeadsRepo({ db, tenantId: otherTenantId }).byId(transfer.id),
		).toBeNull();
		expect((await leadsRepo().findByContactId(contact.id))?.id).toBe(food.id);
		expect(
			(await leadsRepo().findAllByContact(contact.id)).map((l) => l.id),
		).toEqual([food.id, transfer.id]);
		expect(
			(await leadsRepo().findByContactAndType(contact.id, "transfer"))?.id,
		).toBe(transfer.id);
		expect(
			await leadsRepo().findByContactAndType(contact.id, "tour"),
		).toBeNull();

		await leadsRepo().updateState(transfer.id, "transfer_offer", now + 20);
		expect((await leadsRepo().byId(transfer.id))?.state).toBe("transfer_offer");
	});
});

describe("MessagesRepo", () => {
	it("insert/findUserByExternalId/recent/count handle dedupe fields and filtering", async () => {
		if (!enabled) return;
		const contact = await contactsRepo().create({
			displayName: "Message contact",
		});
		const [conversation] = await db
			.insert(schema.conversations)
			.values({
				tenantId,
				userId: contact.id,
				source: "bot",
				mode: "ai",
				createdAt: now,
				lastMessageAt: now,
			})
			.returning({ id: schema.conversations.id });
		if (!conversation) throw new Error("conversation insert returned no row");
		const conversationId = conversation.id;

		const user = await messagesRepo().insert({
			conversationId,
			role: "user",
			text: "hello",
			externalMessageId: "101",
			metaJson: JSON.stringify({ raw: true }),
			stage: "intake",
			nowEpoch: now,
		});
		await messagesRepo().insert({
			conversationId,
			role: "assistant",
			text: "reply",
			nowEpoch: now + 1,
		});
		const deleted = await messagesRepo().insert({
			conversationId,
			role: "human",
			text: "deleted",
			nowEpoch: now + 2,
		});
		await messagesRepo().insert({
			conversationId,
			role: "system",
			text: "internal",
			nowEpoch: now + 3,
		});
		await db
			.update(schema.messages)
			.set({ deletedAt: now + 4 })
			.where(eq(schema.messages.id, deleted.id));

		expect(
			(await messagesRepo().findUserByExternalId(conversationId, "101"))?.id,
		).toBe(user.id);
		expect(
			await messagesRepo().findUserByExternalId(conversationId, "not-a-number"),
		).toBeNull();
		const recent = await messagesRepo().recent(conversationId, 10);
		expect(recent.map((m) => m.text)).toEqual(["hello", "reply"]);
		expect(await messagesRepo().countByConversation(conversationId)).toBe(2);
	});
});

describe("SkillOutcomesRepo", () => {
	it("record is idempotent, byLeadId returns rows and aggregates map counts", async () => {
		if (!enabled) return;
		const contact = await contactsRepo().create({
			displayName: "Outcome contact",
		});
		const lead = await leadsRepo().create({
			contactId: contact.id,
			state: "intake",
			nowEpoch: now,
		});

		expect(
			await outcomesRepo().record({
				leadId: lead.id,
				skillSlug: "clarity",
				outcome: "won",
				source: "manual",
				styleSlug: "style-a",
				nowEpoch: now,
			}),
		).toBe(true);
		expect(
			await outcomesRepo().record({
				leadId: lead.id,
				skillSlug: "clarity",
				outcome: "lost",
				source: "manual",
				nowEpoch: now + 1,
			}),
		).toBe(false);
		expect(
			await outcomesRepo().record({
				leadId: lead.id,
				skillSlug: "empathy",
				outcome: "draw",
				source: "self_play",
				nowEpoch: now + 2,
			}),
		).toBe(true);

		expect(
			(await outcomesRepo().byLeadId(lead.id))
				.map((row) => row.skillSlug)
				.sort(),
		).toEqual(["clarity", "empathy"]);
		const aggregates = await outcomesRepo().aggregates();
		expect(aggregates.find((row) => row.skillSlug === "clarity")).toMatchObject(
			{ wins: 1, losses: 0, draws: 0, total: 1 },
		);
		expect(aggregates.find((row) => row.skillSlug === "empathy")).toMatchObject(
			{ wins: 0, losses: 0, draws: 1, total: 1 },
		);
	});
});
