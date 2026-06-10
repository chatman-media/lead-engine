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
import { ProviderRouter } from "./provider-routing.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_provider_routing_${Math.random().toString(36).slice(2, 10)}`;
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
let tenantId = 0;
let now = 0;
let customerContactId = 0;

const router = () => new ProviderRouter({ db, tenantId });

async function createContact(displayName: string): Promise<number> {
	const [contact] = await db
		.insert(schema.contacts)
		.values({
			tenantId,
			displayName,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.contacts.id });
	if (!contact) throw new Error("contact insert returned no row");
	return contact.id;
}

async function createProvider(opts: {
	name: string;
	status?: "active" | "paused" | "archived";
	profileArea?: string | null;
	serviceType?: string;
	serviceArea?: string | null;
	serviceActive?: boolean;
}): Promise<{ providerId: number; serviceId: number }> {
	const contactId = await createContact(`${opts.name} contact`);
	const [provider] = await db
		.insert(schema.providerProfiles)
		.values({
			tenantId,
			contactId,
			name: opts.name,
			category: opts.serviceType ?? "massage",
			status: opts.status ?? "active",
			serviceArea: opts.profileArea ?? null,
			defaultCommissionPct: 15,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.providerProfiles.id });
	if (!provider) throw new Error("provider insert returned no row");

	const [service] = await db
		.insert(schema.providerServices)
		.values({
			tenantId,
			providerId: provider.id,
			serviceType: opts.serviceType ?? "massage",
			name: `${opts.name} service`,
			serviceArea: opts.serviceArea ?? null,
			isActive: opts.serviceActive ?? true,
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: schema.providerServices.id });
	if (!service) throw new Error("provider service insert returned no row");

	return { providerId: provider.id, serviceId: service.id };
}

async function createAssignedOrder(
	providerId: number,
	status: string,
	createdAt: number,
): Promise<void> {
	await db.insert(schema.serviceOrders).values({
		tenantId,
		customerContactId,
		assignedProviderId: providerId,
		requestType: "massage",
		status,
		summary: `load order ${status}`,
		createdAt,
		updatedAt: createdAt,
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
	now = Math.floor(Date.parse("2026-06-09T01:00:00Z") / 1000);

	const [tenant] = await db
		.insert(schema.tenants)
		.values({ slug: `provider-routing-${now}`, status: "active" })
		.returning({ id: schema.tenants.id });
	if (!tenant) throw new Error("tenant insert returned no row");
	tenantId = tenant.id;
	customerContactId = await createContact("Routing customer");
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("ProviderRouter", () => {
	it("returns no_provider_available when no active provider can fulfill service type", async () => {
		if (!enabled) return;
		const result = await router().selectProvider({ serviceType: "tour" });
		expect(result).toEqual({ ok: false, reason: "no_provider_available" });
	});

	it("rejects paused provider override and ignores paused providers in automatic routing", async () => {
		if (!enabled) return;
		const paused = await createProvider({
			name: "Paused Massage",
			status: "paused",
			serviceType: "reflexology",
			serviceArea: "Chaweng",
		});

		expect(
			await router().selectProvider({
				serviceType: "reflexology",
				serviceArea: "Chaweng",
				providerIdOverride: paused.providerId,
			}),
		).toEqual({ ok: false, reason: "provider_paused" });
		expect(
			await router().selectProvider({
				serviceType: "reflexology",
				serviceArea: "Chaweng",
			}),
		).toEqual({ ok: false, reason: "no_provider_available" });
	});

	it("selects the eligible provider with lower active load", async () => {
		if (!enabled) return;
		const busy = await createProvider({
			name: "Busy Massage",
			serviceType: "massage",
			serviceArea: "Chaweng",
		});
		const available = await createProvider({
			name: "Available Massage",
			serviceType: "massage",
			serviceArea: "Chaweng",
		});
		await createAssignedOrder(busy.providerId, "awaiting_provider", now + 10);
		await createAssignedOrder(busy.providerId, "confirmed", now + 11);
		await createAssignedOrder(available.providerId, "fulfilled", now + 12);

		const result = await router().selectProvider({
			serviceType: "massage",
			serviceArea: "Chaweng",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected provider candidate");
		expect(result.candidate.providerId).toBe(available.providerId);
		expect(result.candidate.activeOrderCount).toBe(0);
		expect(result.override).toBe(false);
	});

	it("returns area_unavailable when service exists but not in requested area", async () => {
		if (!enabled) return;
		await createProvider({
			name: "Phuket Spa",
			serviceType: "spa_package",
			serviceArea: "Phuket",
		});

		expect(
			await router().selectProvider({
				serviceType: "spa_package",
				serviceArea: "Lamai",
			}),
		).toEqual({ ok: false, reason: "area_unavailable" });
	});

	it("operator override selects a specific active provider even with higher load", async () => {
		if (!enabled) return;
		const preferred = await createProvider({
			name: "Preferred Yoga",
			serviceType: "yoga",
			serviceArea: "Chaweng",
		});
		await createProvider({
			name: "Low Load Yoga",
			serviceType: "yoga",
			serviceArea: "Chaweng",
		});
		await createAssignedOrder(preferred.providerId, "confirmed", now + 20);

		const result = await router().selectProvider({
			serviceType: "yoga",
			serviceArea: "Chaweng",
			providerIdOverride: preferred.providerId,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected provider candidate");
		expect(result.candidate.providerId).toBe(preferred.providerId);
		expect(result.candidate.activeOrderCount).toBe(1);
		expect(result.override).toBe(true);
	});
});
