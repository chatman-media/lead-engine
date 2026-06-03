import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	setEncryptedSecret,
	withTenant,
} from "@chatman-media/conversation-engine";
import {
	applyAllMigrations,
	channelIdentities,
	channels,
	contacts,
	conversations,
	createIsolatedDb,
	exchangeOrders,
	exchangeRates,
	exchangeRateTiers,
	schema,
	tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { updateOrder } from "./orders.ts";
import { makeExchangeTools } from "./tools.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_exchange_forsanya_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"..",
	"packages",
	"storage",
	"migrations",
);
const fixturesPath = resolve(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"..",
	"apps",
	"vertical-exchange",
	"evals",
	"forsanya-exchange-workflows.jsonl",
);
const MASTER_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let channelId = 0;

type ToolMap = Record<
	string,
	{ execute: (args: Record<string, unknown>) => Promise<unknown> }
>;

interface FixtureCase {
	id: string;
	title: string;
	messages: Array<{ date: string; from: string; text: string }>;
	expectedWorkflow: string[];
}

interface ScenarioInput {
	fixtureId: string;
	asset: string;
	amount: number;
	amountMode: "source_amount" | "target_thb";
	paymentMethod:
		| "crypto_transfer"
		| "sbp_qr"
		| "card_transfer"
		| "bank_transfer";
	paymentRail?: string;
	sourceBank?: string;
	payoutMethod:
		| "courier_cash"
		| "cardless_atm"
		| "thai_bank_transfer"
		| "office_cash"
		| "atm";
	payoutLocation: string;
	payoutDestination?: Record<string, unknown>;
	expectRequisitesKind: "crypto" | "fiat";
	expectNeedsVerification?: boolean;
}

const SCENARIOS: ScenarioInput[] = [
	{
		fixtureId: "rub-qr-kyc-courier-pattaya-10k-thb",
		asset: "RUB",
		amount: 10_000,
		amountMode: "target_thb",
		paymentMethod: "sbp_qr",
		paymentRail: "sbp",
		sourceBank: "T-Bank",
		payoutMethod: "courier_cash",
		payoutLocation: "Pattaya hotel",
		payoutDestination: { kind: "hotel", city: "Pattaya" },
		expectRequisitesKind: "fiat",
		expectNeedsVerification: true,
	},
	{
		fixtureId: "usdt-trc20-wallet-delivery-60k-thb",
		asset: "USDT",
		amount: 60_000,
		amountMode: "target_thb",
		paymentMethod: "crypto_transfer",
		paymentRail: "trc20",
		payoutMethod: "courier_cash",
		payoutLocation: "Pratamnak",
		payoutDestination: { kind: "hotel", area: "Pratamnak" },
		expectRequisitesKind: "crypto",
	},
	{
		fixtureId: "rub-card-to-cardless-atm-22k-thb",
		asset: "RUB",
		amount: 22_000,
		amountMode: "target_thb",
		paymentMethod: "card_transfer",
		paymentRail: "sber",
		sourceBank: "Sber",
		payoutMethod: "cardless_atm",
		payoutLocation: "SCB ATM",
		payoutDestination: { atmBank: "SCB" },
		expectRequisitesKind: "fiat",
	},
	{
		fixtureId: "rub-qr-atm-first-time-faq",
		asset: "RUB",
		amount: 45_000,
		amountMode: "source_amount",
		paymentMethod: "sbp_qr",
		paymentRail: "sbp",
		payoutMethod: "cardless_atm",
		payoutLocation: "KBank ATM",
		payoutDestination: { atmBank: "KBank" },
		expectRequisitesKind: "fiat",
	},
	{
		fixtureId: "rub-qr-kyc-cardless-atm-12900-thb",
		asset: "RUB",
		amount: 12_900,
		amountMode: "target_thb",
		paymentMethod: "sbp_qr",
		paymentRail: "sbp",
		payoutMethod: "cardless_atm",
		payoutLocation: "green/yellow ATM",
		payoutDestination: { atmBank: "KBank" },
		expectRequisitesKind: "fiat",
		expectNeedsVerification: true,
	},
	{
		fixtureId: "rub-qr-bank-transfer-to-bangkok-bank",
		asset: "RUB",
		amount: 45_000,
		amountMode: "target_thb",
		paymentMethod: "sbp_qr",
		paymentRail: "sbp",
		payoutMethod: "thai_bank_transfer",
		payoutLocation: "Bangkok Bank",
		payoutDestination: { thaiBank: "Bangkok Bank" },
		expectRequisitesKind: "fiat",
	},
	{
		fixtureId: "rub-qr-tinkoff-to-bangkok-bank",
		asset: "RUB",
		amount: 32_000,
		amountMode: "target_thb",
		paymentMethod: "sbp_qr",
		paymentRail: "sbp",
		sourceBank: "T-Bank",
		payoutMethod: "thai_bank_transfer",
		payoutLocation: "Bangkok Bank",
		payoutDestination: { thaiBank: "Bangkok Bank" },
		expectRequisitesKind: "fiat",
	},
	{
		fixtureId: "rub-to-bangkok-bank-payout-45k-thb",
		asset: "RUB",
		amount: 45_000,
		amountMode: "target_thb",
		paymentMethod: "sbp_qr",
		paymentRail: "sbp",
		payoutMethod: "thai_bank_transfer",
		payoutLocation: "Bangkok Bank",
		payoutDestination: { thaiBank: "Bangkok Bank" },
		expectRequisitesKind: "fiat",
	},
	{
		fixtureId: "usdt-binance-id-small-2500-thb",
		asset: "USDT",
		amount: 2_500,
		amountMode: "target_thb",
		paymentMethod: "crypto_transfer",
		paymentRail: "binance_id",
		payoutMethod: "office_cash",
		payoutLocation: "office",
		expectRequisitesKind: "crypto",
	},
	{
		fixtureId: "rub-sber-cardless-atm-10k-thb",
		asset: "RUB",
		amount: 10_000,
		amountMode: "target_thb",
		paymentMethod: "card_transfer",
		paymentRail: "sber",
		sourceBank: "Sber",
		payoutMethod: "cardless_atm",
		payoutLocation: "SCB ATM",
		payoutDestination: { atmBank: "SCB" },
		expectRequisitesKind: "fiat",
	},
];

function must<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined)
		throw new Error(`Missing ${label}`);
	return value;
}

function loadFixtures(): FixtureCase[] {
	return readFileSync(fixturesPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FixtureCase);
}

async function seedRatesAndSecrets() {
	const now = Math.floor(Date.now() / 1000);
	await withTenant(db, tenantId, async (tx) => {
		await tx.insert(exchangeRates).values([
			{
				tenantId,
				asset: "RUB",
				quoteAsset: "THB",
				network: "",
				baseRate: 2.55,
				quoteMode: "divide",
				autoUpdate: true,
				createdAt: now,
				updatedAt: now,
			},
			{
				tenantId,
				asset: "USDT",
				quoteAsset: "THB",
				network: "trc20",
				baseRate: 31.5,
				quoteMode: "multiply",
				autoUpdate: true,
				createdAt: now,
				updatedAt: now,
			},
		]);
		await tx.insert(exchangeRateTiers).values([
			{
				tenantId,
				asset: "RUB",
				quoteAsset: "THB",
				network: "",
				minAmount: 2_000,
				maxAmount: 3_000,
				marketRate: 2.55,
				displayRate: 2.64,
				deviationPct: 3.5294,
				approvedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			{
				tenantId,
				asset: "RUB",
				quoteAsset: "THB",
				network: "",
				minAmount: 3_000,
				maxAmount: 7_000,
				marketRate: 2.55,
				displayRate: 2.59,
				deviationPct: 1.5686,
				approvedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			{
				tenantId,
				asset: "RUB",
				quoteAsset: "THB",
				network: "",
				minAmount: 7_000,
				maxAmount: 20_000,
				marketRate: 2.55,
				displayRate: 2.52,
				deviationPct: -1.1765,
				approvedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			{
				tenantId,
				asset: "RUB",
				quoteAsset: "THB",
				network: "",
				minAmount: 20_000,
				maxAmount: 50_000,
				marketRate: 2.55,
				displayRate: 2.48,
				deviationPct: -2.7451,
				approvedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			{
				tenantId,
				asset: "RUB",
				quoteAsset: "THB",
				network: "",
				minAmount: 50_000,
				maxAmount: null,
				marketRate: 2.55,
				displayRate: 2.39,
				deviationPct: -6.2745,
				approvedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			{
				tenantId,
				asset: "USDT",
				quoteAsset: "THB",
				network: "trc20",
				minAmount: 2_000,
				maxAmount: 10_000,
				marketRate: 31.5,
				displayRate: 31.35,
				deviationPct: -0.4762,
				approvedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			{
				tenantId,
				asset: "USDT",
				quoteAsset: "THB",
				network: "trc20",
				minAmount: 10_000,
				maxAmount: 100_000,
				marketRate: 31.5,
				displayRate: 31.45,
				deviationPct: -0.1587,
				approvedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			{
				tenantId,
				asset: "USDT",
				quoteAsset: "THB",
				network: "trc20",
				minAmount: 100_000,
				maxAmount: null,
				marketRate: 31.5,
				displayRate: 31.7,
				deviationPct: 0.6349,
				approvedAt: now,
				createdAt: now,
				updatedAt: now,
			},
		]);
	});

	await setEncryptedSecret({
		db,
		tenantId,
		key: "exchange_wallet_usdt_trc20",
		value: "TMockForsanyaWallet111111111111111111",
		masterKeyHex: MASTER_KEY,
		nowEpoch: now,
	});
	await setEncryptedSecret({
		db,
		tenantId,
		key: "exchange_binance_id",
		value: "66775963",
		masterKeyHex: MASTER_KEY,
		nowEpoch: now,
	});
	await setEncryptedSecret({
		db,
		tenantId,
		key: "exchange_fiat_payment_url",
		value: "https://mock.local/sbp/qr",
		masterKeyHex: MASTER_KEY,
		nowEpoch: now,
	});
	await setEncryptedSecret({
		db,
		tenantId,
		key: "exchange_rub_card_requisites",
		value: "💳 MOCK RUB CARD REQUISITES",
		masterKeyHex: MASTER_KEY,
		nowEpoch: now,
	});
}

async function makeConversation(fixture: FixtureCase, verified: boolean) {
	const now = Math.floor(Date.now() / 1000);
	return withTenant(db, tenantId, async (tx) => {
		const [contact] = await tx
			.insert(contacts)
			.values({
				tenantId,
				displayName: fixture.title,
				attributesJson: verified
					? JSON.stringify({
							exchangeKyc: {
								status: "verified",
								verificationId: `kyc-${fixture.id}`,
							},
						})
					: null,
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: contacts.id });
		const contactId = must(contact, "contact").id;
		const [conversation] = await tx
			.insert(conversations)
			.values({
				tenantId,
				userId: contactId,
				source: "bot",
				mode: "ai",
				createdAt: now,
				lastMessageAt: now,
			})
			.returning({ id: conversations.id });
		const conversationId = must(conversation, "conversation").id;
		await tx.insert(channelIdentities).values({
			contactId,
			channelId,
			externalUserId: `tg-${fixture.id}-${verified ? "verified" : "initial"}`,
			createdAt: now,
		});
		return { contactId, conversationId };
	});
}

function toTools(conversationId: number): ToolMap {
	return Object.fromEntries(
		makeExchangeTools({
			db,
			tenantId,
			conversationId,
			masterKeyHex: MASTER_KEY,
		}).map((tool) => [tool.name, tool]),
	) as ToolMap;
}

beforeAll(async () => {
	if (!ownerUrl) return;
	const probe = await tryConnectToPg(ownerUrl);
	if (!probe) return;
	await probe.end({ timeout: 0 });

	const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
	sql = postgres(testUrl, { max: 3, onnotice: () => {} });
	await applyAllMigrations(sql, migrationsDir);
	db = drizzle(sql, { schema });

	const now = Math.floor(Date.now() / 1000);
	const [tenant] = await db
		.insert(schema.tenants)
		.values({ slug: `forsanya-${now}` })
		.returning({ id: schema.tenants.id });
	tenantId = must(tenant, "tenant").id;
	await withTenant(db, tenantId, async (tx) => {
		const [channel] = await tx
			.insert(channels)
			.values({
				tenantId,
				kind: "telegram_bot",
				externalId: "mock-tg",
				status: "active",
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: channels.id });
		channelId = must(channel, "channel").id;
	});
	await seedRatesAndSecrets();
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("Forsanya exchange workflow fixtures", () => {
	it("loads exactly 10 redacted workflow documents", () => {
		const fixtures = loadFixtures();
		expect(fixtures).toHaveLength(10);
		for (const fixture of fixtures) {
			expect(fixture.messages.length).toBeGreaterThan(0);
			expect(JSON.stringify(fixture)).not.toContain("https://qr.nspk.ru");
			expect(JSON.stringify(fixture)).not.toContain("2202 ");
			expect(JSON.stringify(fixture)).not.toContain("063 186");
			expect(JSON.stringify(fixture)).not.toContain("Код: 289");
			expect(JSON.stringify(fixture)).not.toContain("Максим");
			expect(JSON.stringify(fixture)).not.toContain("Маргарита");
		}
	});

	for (const scenario of SCENARIOS) {
		it(`${scenario.fixtureId}: creates order/requisites/proof/payout through mocked tools`, async () => {
			if (!sql) return;
			const fixture = must(
				loadFixtures().find((item) => item.id === scenario.fixtureId),
				`fixture ${scenario.fixtureId}`,
			);

			const first = await makeConversation(
				fixture,
				!scenario.expectNeedsVerification,
			);
			let tools = toTools(first.conversationId);

			const quote = (await must(
				tools.compute_exchange_quote,
				"compute_exchange_quote",
			).execute({
				asset: scenario.asset,
				amount: scenario.amount,
				amountMode: scenario.amountMode,
				network: scenario.asset === "USDT" ? "trc20" : undefined,
			})) as Record<string, unknown>;
			expect(quote.amountToThb).toBeGreaterThan(0);
			if (scenario.amountMode === "target_thb")
				expect(quote.amountToThb).toBe(scenario.amount);

			let activeConversationId = first.conversationId;
			let create = (await must(
				tools.create_exchange_order,
				"create_exchange_order",
			).execute({
				asset: scenario.asset,
				amount: scenario.amount,
				amountMode: scenario.amountMode,
				network: scenario.asset === "USDT" ? "trc20" : undefined,
				paymentMethod: scenario.paymentMethod,
				paymentRail: scenario.paymentRail,
				sourceBank: scenario.sourceBank,
				payoutMethod: scenario.payoutMethod,
				payoutLocation: scenario.payoutLocation,
				payoutDestination: scenario.payoutDestination,
			})) as Record<string, unknown>;

			if (scenario.expectNeedsVerification) {
				expect(create.needsVerification).toBe(true);
				const verified = await makeConversation(fixture, true);
				activeConversationId = verified.conversationId;
				tools = toTools(activeConversationId);
				create = (await must(
					tools.create_exchange_order,
					"create_exchange_order",
				).execute({
					asset: scenario.asset,
					amount: scenario.amount,
					amountMode: scenario.amountMode,
					network: scenario.asset === "USDT" ? "trc20" : undefined,
					paymentMethod: scenario.paymentMethod,
					paymentRail: scenario.paymentRail,
					sourceBank: scenario.sourceBank,
					payoutMethod: scenario.payoutMethod,
					payoutLocation: scenario.payoutLocation,
					payoutDestination: scenario.payoutDestination,
				})) as Record<string, unknown>;
			}

			expect(create.status).toBe("awaiting_payment");
			expect(typeof create.orderId).toBe("number");

			const requisites = (await must(
				tools.fetch_exchange_requisites,
				"fetch_exchange_requisites",
			).execute({})) as Record<string, unknown>;
			expect(requisites.kind).toBe(scenario.expectRequisitesKind);
			expect(typeof requisites.instructions).toBe("string");
			if (scenario.paymentRail === "binance_id")
				expect(requisites.exchangeId).toBe("66775963");
			if (scenario.paymentMethod === "card_transfer")
				expect(requisites.detailsText).toContain("MOCK RUB CARD");

			const orderId = create.orderId as number;
			if (scenario.asset === "RUB") {
				const proof = (await must(
					tools.verify_exchange_payment,
					"verify_exchange_payment",
				).execute({
					proof: "mock receipt uploaded",
					sourceBank: scenario.sourceBank ?? "Sber",
					receiptAmount:
						scenario.amountMode === "target_thb"
							? Number(create.amountFrom)
							: scenario.amount,
					payerName: "Mock Payer",
					paymentReference: `ref-${scenario.fixtureId}`,
				})) as Record<string, unknown>;
				expect(proof.needsOperator).toBe(true);
				expect(typeof proof.sourceBank).toBe("string");
			}

			await updateOrder(db, tenantId, orderId, {
				status: "paid",
				payoutCode: `CODE-${orderId}`,
			});
			const payout = (await must(
				tools.issue_exchange_payout,
				"issue_exchange_payout",
			).execute({
				payoutMethod: scenario.payoutMethod,
				location: scenario.payoutLocation,
				destination: scenario.payoutDestination ?? {},
			})) as Record<string, unknown>;
			expect(payout.payoutCode).toBe(`CODE-${orderId}`);

			const [row] = await withTenant(db, tenantId, (tx) =>
				tx
					.select()
					.from(exchangeOrders)
					.where(
						and(
							eq(exchangeOrders.tenantId, tenantId),
							eq(exchangeOrders.id, orderId),
						),
					)
					.limit(1),
			);
			const order = must(row, "exchange order");
			expect(order.conversationId).toBe(activeConversationId);
			expect(order.amountMode).toBe(scenario.amountMode);
			expect(order.requestedAmount).toBe(scenario.amount);
			expect(order.paymentMethod).toBe(scenario.paymentMethod);
			expect(order.payoutMethod).toBe(scenario.payoutMethod);
			expect(order.verificationId).toBe(`kyc-${scenario.fixtureId}`);
			if (scenario.asset === "RUB")
				expect(order.proofJson).toContain("fiat_receipt");
		});
	}
});
