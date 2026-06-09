import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
	applyAllMigrations,
	createIsolatedDb,
	earlyAccessSignups,
	schema,
	tryConnectToPg,
} from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { makePublicEarlyAccessRoutes } from "./public-early-access.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_early_access_${Math.random().toString(36).slice(2, 10)}`;
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
	app.route("/", makePublicEarlyAccessRoutes({ db }));
}, 30_000);

afterAll(async () => {
	if (sql) {
		await sql.end({ timeout: 0 }).catch(() => {});
		sql = null;
	}
}, 10_000);

function post(body: unknown, headers: Record<string, string> = {}) {
	return app.request("/api/public/early-access", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

async function rowsFor(email: string) {
	return db
		.select()
		.from(earlyAccessSignups)
		.where(eq(earlyAccessSignups.email, email));
}

describe("public early access", () => {
	it("stores early access requests and updates duplicate emails idempotently", async () => {
		if (!sql) return;

		const first = await post(
			{
				email: " Founder@Example.COM ",
				name: "Alex",
				company: "Island Ops",
				useCase: "exchange + real estate workflows",
				source: "landing_alpha",
				locale: "ru",
			},
			{ "User-Agent": "early-access-test", "X-Forwarded-For": "203.0.113.10" },
		);
		expect(first.status).toBe(200);
		expect(first.headers.get("access-control-allow-origin")).toBe("*");

		const stored = await rowsFor("founder@example.com");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.name).toBe("Alex");
		expect(stored[0]?.company).toBe("Island Ops");
		expect(stored[0]?.useCase).toBe("exchange + real estate workflows");
		expect(stored[0]?.userAgent).toBe("early-access-test");
		expect(stored[0]?.ip).toBe("203.0.113.10");

		const second = await post({
			email: "founder@example.com",
			company: "Lead Desk",
			useCase: "provider marketplace",
			locale: "en",
		});
		expect(second.status).toBe(200);

		const updated = await rowsFor("founder@example.com");
		expect(updated).toHaveLength(1);
		expect(updated[0]?.company).toBe("Lead Desk");
		expect(updated[0]?.useCase).toBe("provider marketplace");
		expect(updated[0]?.locale).toBe("en");
		expect(updated[0]?.name).toBe("Alex");
	});

	it("rejects invalid email and ignores honeypot submissions", async () => {
		if (!sql) return;

		const bad = await post({ email: "not-email" });
		expect(bad.status).toBe(400);

		const bot = await post({
			email: "bot@example.com",
			website: "https://spam.test",
		});
		expect(bot.status).toBe(200);

		const rows = await rowsFor("bot@example.com");
		expect(rows).toHaveLength(0);
	});
});
