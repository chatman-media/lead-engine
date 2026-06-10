/**
 * ensureAndAdvanceLeadByPhase — find-or-create лида на активной воронке и
 * продвижение вперёд по фазе под текущую sales-стадию диалога. Требует
 * DATABASE_URL; без него — graceful-skip.
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
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { ensureAndAdvanceLeadByPhase } from "./lead-advance.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_ladv_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"storage",
	"migrations",
);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let n = 0;
let tenantWithFunnel = 0;
let tenantNoFunnel = 0;

async function makeStage(
	tenantId: number,
	funnelId: number,
	slug: string,
	kind: string,
	phase: string | null,
	position: number,
) {
	await db.insert(schema.stageDefinitions).values({
		tenantId,
		funnelId,
		slug,
		displayName: slug,
		kind,
		stageType: "form_fill",
		...(phase ? { phase } : {}),
		position,
		nextStages: [],
		createdAt: n,
		updatedAt: n,
	});
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
		.values({ slug: `ladv-a-${n}` })
		.returning({ id: schema.tenants.id });
	tenantWithFunnel = a!.id;
	const [b] = await db
		.insert(schema.tenants)
		.values({ slug: `ladv-b-${n}` })
		.returning({ id: schema.tenants.id });
	tenantNoFunnel = b!.id;

	const [f] = await db
		.insert(schema.funnels)
		.values({
			tenantId: tenantWithFunnel,
			slug: "main",
			isActive: true,
			createdAt: n,
			updatedAt: n,
		})
		.returning({ id: schema.funnels.id });
	const fid = f!.id;
	await makeStage(tenantWithFunnel, fid, "intake", "intake", null, 0);
	await makeStage(tenantWithFunnel, fid, "qual", "active", "qualify", 1);
	await makeStage(tenantWithFunnel, fid, "offer", "active", "offer", 2);
	await makeStage(tenantWithFunnel, fid, "verify", "active", "clear", 3);
	await makeStage(tenantWithFunnel, fid, "deal", "active", "fulfill", 4);
	await makeStage(tenantWithFunnel, fid, "won", "terminal_won", "fulfill", 5);
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

async function freshContact(tenantId: number): Promise<number> {
	const [c] = await db
		.insert(schema.contacts)
		.values({
			tenantId,
			displayName: `c-${Math.random().toString(36).slice(2, 8)}`,
			createdAt: n,
		})
		.returning({ id: schema.contacts.id });
	return c!.id;
}

describe("ensureAndAdvanceLeadByPhase", () => {
	it("нет активной воронки → null", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantNoFunnel);
		const r = await ensureAndAdvanceLeadByPhase({
			db,
			tenantId: tenantNoFunnel,
			contactId,
			salesStage: "qualify",
			nowEpoch: n,
		});
		expect(r).toBeNull();
	});

	it("новый лид: создаётся на intake и двигается в qualify-фазу", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const r = await ensureAndAdvanceLeadByPhase({
			db,
			tenantId: tenantWithFunnel,
			contactId,
			salesStage: "qualify",
			nowEpoch: n,
		});
		expect(r).not.toBeNull();
		expect(r!.created).toBe(true);
		expect(r!.advanced).toBe(true);
		expect(r!.stageSlug).toBe("qual");
	});

	it("pitch → offer-фаза", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const r = await ensureAndAdvanceLeadByPhase({
			db,
			tenantId: tenantWithFunnel,
			contactId,
			salesStage: "pitch",
			nowEpoch: n,
		});
		expect(r!.stageSlug).toBe("offer");
		expect(r!.advanced).toBe(true);
	});

	it("opener (нет маппинга) → advanced=false, остаётся на intake", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const r = await ensureAndAdvanceLeadByPhase({
			db,
			tenantId: tenantWithFunnel,
			contactId,
			salesStage: "opener",
			nowEpoch: n,
		});
		expect(r!.created).toBe(true);
		expect(r!.advanced).toBe(false);
		expect(r!.stageSlug).toBe("intake");
	});

	it("не двигается назад: лид на offer, salesStage=qualify → advanced=false", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		// сначала продвинем до offer
		await ensureAndAdvanceLeadByPhase({
			db,
			tenantId: tenantWithFunnel,
			contactId,
			salesStage: "pitch",
			nowEpoch: n,
		});
		// теперь «назад» в qualify
		const r = await ensureAndAdvanceLeadByPhase({
			db,
			tenantId: tenantWithFunnel,
			contactId,
			salesStage: "qualify",
			nowEpoch: n,
		});
		expect(r!.created).toBe(false);
		expect(r!.advanced).toBe(false);
		expect(r!.stageSlug).toBe("offer");
	});

	it("close из fulfill-фазы → эскалация до terminal_won", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		// довести до fulfill (deal)
		await ensureAndAdvanceLeadByPhase({
			db,
			tenantId: tenantWithFunnel,
			contactId,
			salesStage: "close",
			nowEpoch: n,
		});
		// лид теперь на deal (fulfill); повторный close → terminal_won
		const r = await ensureAndAdvanceLeadByPhase({
			db,
			tenantId: tenantWithFunnel,
			contactId,
			salesStage: "close",
			nowEpoch: n,
		});
		expect(r!.stageSlug).toBe("won");
		// проверим что lead.state действительно won
		const [lead] = await db
			.select({ state: schema.leads.state })
			.from(schema.leads)
			.where(
				and(
					eq(schema.leads.tenantId, tenantWithFunnel),
					eq(schema.leads.userId, contactId),
				),
			);
		expect(lead!.state).toBe("won");
	});
});
