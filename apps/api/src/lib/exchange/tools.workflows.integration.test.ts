import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
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
	funnels,
	leads,
	schema,
	stageDefinitions,
	tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { updateOrder } from "./orders.ts";
import { makeExchangeTools } from "./tools.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_exchange_workflows_${Math.random().toString(36).slice(2, 10)}`;
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
	"exchange-workflows.jsonl",
);
const MASTER_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const realFetch = globalThis.fetch;

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
		value: "TMockExchangeWallet111111111111111111",
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

function mockTronscanPayment(opts: {
	txHash: string;
	toAddress?: string;
	amount?: number;
	timestamp?: number;
}): void {
	const toAddress = opts.toAddress ?? "TMockExchangeWallet111111111111111111";
	const amount = opts.amount ?? 100;
	const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000) * 1000;
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		expect(String(input)).toContain(opts.txHash);
		return new Response(
			JSON.stringify({
				confirmed: true,
				contractRet: "SUCCESS",
				timestamp,
				trc20TransferInfo: [
					{
						to_address: toAddress,
						from_address: "TReplaySource",
						amount_str: String(Math.round(amount * 1_000_000)),
						decimals: 6,
						symbol: "USDT",
					},
				],
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
}

async function createCryptoOrderForVerification(id: string): Promise<{
	orderId: number;
	tools: ToolMap;
}> {
	const { conversationId } = await makeConversation(
		{
			id,
			title: `Crypto ${id}`,
			messages: [],
			expectedWorkflow: [],
		},
		true,
	);
	const tools = toTools(conversationId);
	const created = (await must(
		tools.create_exchange_order,
		"create_exchange_order",
	).execute({
		asset: "USDT",
		amount: 100,
		amountMode: "source_amount",
		network: "trc20",
		paymentMethod: "crypto_transfer",
		paymentRail: "trc20",
		payoutMethod: "office_cash",
		payoutLocation: "office",
	})) as Record<string, unknown>;
	await must(
		tools.fetch_exchange_requisites,
		"fetch_exchange_requisites",
	).execute({});
	return { orderId: created.orderId as number, tools };
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
		.values({ slug: `exchange-${now}` })
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

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("Exchange workflow fixtures", () => {
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
			expect(JSON.stringify(fixture)).not.toContain("Exasia");
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

			// TTL: просроченный код боту не выдаётся — снова кейс оператора.
			await updateOrder(db, tenantId, orderId, {
				payoutCodeExpiresAt: Math.floor(Date.now() / 1000) - 60,
			});
			const expired = (await must(
				tools.issue_exchange_payout,
				"issue_exchange_payout",
			).execute({
				payoutMethod: scenario.payoutMethod,
				location: scenario.payoutLocation,
				destination: scenario.payoutDestination ?? {},
			})) as Record<string, unknown>;
			expect(expired.payoutCode).toBeUndefined();
			expect(expired.needsOperator).toBe(true);
			expect(expired.codeExpired).toBe(true);

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

	it("rejects replayed crypto tx hash on a second order", async () => {
		if (!sql) return;
		const txHash = "b".repeat(64);
		mockTronscanPayment({ txHash });

		const first = await createCryptoOrderForVerification("replay-first");
		const firstProof = (await must(
			first.tools.verify_exchange_payment,
			"verify_exchange_payment",
		).execute({ proof: `https://tronscan.org/#/transaction/${txHash}` })) as Record<
			string,
			unknown
		>;
		expect(firstProof.ok).toBe(true);

		const second = await createCryptoOrderForVerification("replay-second");
		const secondProof = (await must(
			second.tools.verify_exchange_payment,
			"verify_exchange_payment",
		).execute({ proof: txHash })) as Record<string, unknown>;
		expect(secondProof.ok).toBe(false);
		expect(secondProof.needsOperator).toBe(true);
		expect(secondProof.duplicateOrderId).toBe(first.orderId);

		const rows = await withTenant(db, tenantId, (tx) =>
			tx
				.select({
					id: exchangeOrders.id,
					status: exchangeOrders.status,
					proofJson: exchangeOrders.proofJson,
				})
				.from(exchangeOrders)
				.where(
					and(
						eq(exchangeOrders.tenantId, tenantId),
						eq(exchangeOrders.id, second.orderId),
					),
				),
		);
		const row = must(rows[0], "second replay order");
		expect(row.status).toBe("awaiting_payment");
		expect(row.proofJson).toContain("tx_hash_replay");
	});

	it("allows only one paid order when two verifies race with the same crypto tx hash", async () => {
		if (!sql) return;
		const txHash = "c".repeat(64);
		mockTronscanPayment({ txHash });
		const first = await createCryptoOrderForVerification("race-first");
		const second = await createCryptoOrderForVerification("race-second");

		const results = (await Promise.all([
			must(first.tools.verify_exchange_payment, "verify_exchange_payment").execute({
				proof: txHash,
			}),
			must(second.tools.verify_exchange_payment, "verify_exchange_payment").execute({
				proof: txHash,
			}),
		])) as [Record<string, unknown>, Record<string, unknown>];

		expect(results.filter((result) => result.ok === true)).toHaveLength(1);
		expect(results.filter((result) => result.needsOperator === true)).toHaveLength(1);

		const orderRows = await withTenant(db, tenantId, (tx) =>
			tx
				.select({
					id: exchangeOrders.id,
					status: exchangeOrders.status,
					proofJson: exchangeOrders.proofJson,
				})
				.from(exchangeOrders)
				.where(eq(exchangeOrders.tenantId, tenantId)),
		);
		const raced = orderRows.filter((row) =>
			[first.orderId, second.orderId].includes(row.id),
		);
		expect(raced.filter((row) => row.status === "paid")).toHaveLength(1);
		expect(raced.filter((row) => row.proofJson?.includes("tx_hash_replay"))).toHaveLength(1);
	});

	it("keeps old crypto tx hash out of paid status", async () => {
		if (!sql) return;
		const txHash = "d".repeat(64);
		mockTronscanPayment({
			txHash,
			timestamp: (Math.floor(Date.now() / 1000) - 25 * 60 * 60) * 1000,
		});
		const order = await createCryptoOrderForVerification("old-tx");
		const proof = (await must(
			order.tools.verify_exchange_payment,
			"verify_exchange_payment",
		).execute({ proof: txHash })) as Record<string, unknown>;

		expect(proof.ok).toBe(false);
		expect(proof.needsOperator).toBe(true);
		expect(String(proof.reason)).toContain("старше");

		const rows = await withTenant(db, tenantId, (tx) =>
			tx
				.select({ status: exchangeOrders.status, proofJson: exchangeOrders.proofJson })
				.from(exchangeOrders)
				.where(
					and(
						eq(exchangeOrders.tenantId, tenantId),
						eq(exchangeOrders.id, order.orderId),
					),
				),
		);
		const row = must(rows[0], "old tx order");
		expect(row.status).toBe("awaiting_payment");
		expect(row.proofJson).toContain('"verifiedOk":false');
	});

	// A3: бот читает бизнес-настройки (часы/контакт/выдача/KYC/адреса офисов) из секретов.
	it("get_exchange_business_info returns configured settings (A3)", async () => {
		if (!sql) return;
		const now = Math.floor(Date.now() / 1000);
		for (const [key, value] of [
			["exchange_working_hours", "Пн–Вс 09:00–21:00"],
			["exchange_operator_contact", "@phuket_operator"],
			["exchange_office_address", "Бангтао — Soi 5\nПатонг — Jungceylon, 1 этаж"],
		] as const) {
			await setEncryptedSecret({ db, tenantId, key, value, masterKeyHex: MASTER_KEY, nowEpoch: now });
		}
		const { conversationId } = await makeConversation(
			{ id: "a3-info", title: "A3 info" } as Parameters<typeof makeConversation>[0],
			true,
		);
		const tools = toTools(conversationId);
		const info = (await must(tools.get_exchange_business_info, "get_exchange_business_info").execute(
			{},
		)) as Record<string, unknown>;
		expect(info.workingHours).toBe("Пн–Вс 09:00–21:00");
		expect(info.operatorContact).toBe("@phuket_operator");
		expect(info.officeAddress).toBe("Бангтао — Soi 5\nПатонг — Jungceylon, 1 этаж");
		expect(info.officeAddresses).toEqual(["Бангтао — Soi 5", "Патонг — Jungceylon, 1 этаж"]);
	});

	// A4: срабатывание rate-guard вызывает алерт владельцу (notifyRateGuard).
	it("rate-guard trip fires notifyRateGuard (A4)", async () => {
		if (!sql) return;
		const now = Math.floor(Date.now() / 1000);
		await withTenant(db, tenantId, (tx) =>
			tx.insert(exchangeRates).values({
				tenantId,
				asset: "ETH",
				quoteAsset: "THB",
				network: "erc20",
				baseRate: 100000,
				quoteMode: "multiply",
				marginPct: 50, // eff = base*0.5 → отклонение −50% > порога 35% → trips
				autoUpdate: false,
				createdAt: now,
				updatedAt: now,
			}),
		);
		const { conversationId } = await makeConversation(
			{ id: "a4-guard", title: "A4 guard" } as Parameters<typeof makeConversation>[0],
			true,
		);
		const alerts: Array<{ reason: string; asset: string }> = [];
		const tools = Object.fromEntries(
			makeExchangeTools({
				db,
				tenantId,
				conversationId,
				masterKeyHex: MASTER_KEY,
				notifyRateGuard: (a) => alerts.push({ reason: a.reason, asset: a.asset }),
			}).map((t) => [t.name, t]),
		) as Record<string, { execute: (a: unknown) => Promise<unknown> }>;
		await must(tools.compute_exchange_quote, "compute_exchange_quote").execute({
			asset: "ETH",
			amount: 1,
			network: "erc20",
		});
		expect(alerts.length).toBeGreaterThanOrEqual(1);
		expect(alerts[0]?.asset).toBe("ETH");
		expect(alerts[0]?.reason).toBe("implausible_deviation");
	});

	// Регрессия: заявка/реквизиты двигают лида по воронке. Раньше успешный
	// create_exchange_order не звал moveExchangeLeadToStage → лид застревал на
	// quote_calculated, а fetch_exchange_requisites гейтился матрицей стадий.
	it("продвигает лида: order_created при заявке, requisites_sent при реквизитах", async () => {
		if (!sql) return;
		const { contactId, conversationId } = await makeConversation(
			{ id: "stage-advance", title: "Stage advance" } as Parameters<
				typeof makeConversation
			>[0],
			true,
		);
		const now = Math.floor(Date.now() / 1000);
		await withTenant(db, tenantId, async (tx) => {
			const [funnel] = await tx
				.insert(funnels)
				.values({
					tenantId,
					slug: "exchange",
					verticalTemplateId: "exchange_v1",
					isActive: true,
					createdAt: now,
					updatedAt: now,
				})
				.returning({ id: funnels.id });
			const funnelId = must(funnel, "funnel").id;
			const stages = await tx
				.insert(stageDefinitions)
				.values([
					{ tenantId, funnelId, slug: "quote_calculated", displayName: "Курс рассчитан", position: 1 },
					{ tenantId, funnelId, slug: "order_created", displayName: "Заявка создана", position: 5 },
					{ tenantId, funnelId, slug: "requisites_sent", displayName: "Реквизиты отправлены", position: 6 },
				])
				.returning({ id: stageDefinitions.id, slug: stageDefinitions.slug });
			const quote = must(
				stages.find((s) => s.slug === "quote_calculated"),
				"quote stage",
			);
			await tx.insert(leads).values({
				tenantId,
				userId: contactId,
				stageDefinitionId: quote.id,
				state: "quote_calculated",
				createdAt: now,
				updatedAt: now,
			});
		});

		const leadState = () =>
			withTenant(db, tenantId, (tx) =>
				tx
					.select({ state: leads.state })
					.from(leads)
					.where(and(eq(leads.tenantId, tenantId), eq(leads.userId, contactId)))
					.limit(1),
			);

		const tools = toTools(conversationId);
		const created = (await must(
			tools.create_exchange_order,
			"create_exchange_order",
		).execute({
			asset: "USDT",
			amount: 100,
			amountMode: "source_amount",
			network: "trc20",
			paymentMethod: "crypto_transfer",
			paymentRail: "trc20",
			payoutMethod: "office_cash",
			payoutLocation: "office",
		})) as Record<string, unknown>;
		expect(typeof created.orderId).toBe("number");
		expect((await leadState())[0]?.state).toBe("order_created");

		const req = (await must(
			tools.fetch_exchange_requisites,
			"fetch_exchange_requisites",
		).execute({})) as Record<string, unknown>;
		expect(req.needsOperator).not.toBe(true);
		expect((await leadState())[0]?.state).toBe("requisites_sent");
	});

	// Регрессия: повторная заявка той же суммы после протухшей не должна
	// «залипать» на мёртвой заявке (детерминированный idempotency_key) — нужно
	// создать свежую активную, иначе fetch_exchange_requisites её не видит.
	it("повторная заявка после протухшей создаёт свежую (idempotency revive)", async () => {
		if (!sql) return;
		const { conversationId } = await makeConversation(
			{ id: "idem-revive", title: "Idem revive" } as Parameters<
				typeof makeConversation
			>[0],
			true,
		);
		const tools = toTools(conversationId);
		const orderArgs = {
			asset: "USDT",
			amount: 100,
			amountMode: "source_amount",
			network: "trc20",
			paymentMethod: "crypto_transfer",
			paymentRail: "trc20",
			payoutMethod: "office_cash",
			payoutLocation: "office",
		};
		const first = (await must(
			tools.create_exchange_order,
			"create_exchange_order",
		).execute(orderArgs)) as Record<string, unknown>;
		const firstId = first.orderId as number;
		expect(typeof firstId).toBe("number");

		await updateOrder(db, tenantId, firstId, { status: "expired" });

		const second = (await must(
			tools.create_exchange_order,
			"create_exchange_order",
		).execute(orderArgs)) as Record<string, unknown>;
		const secondId = second.orderId as number;
		expect(typeof secondId).toBe("number");
		expect(secondId).not.toBe(firstId);
		expect(second.idempotent).not.toBe(true);

		// Реквизиты выдаются по свежей активной заявке, а не падают на «нет заявки».
		const req = (await must(
			tools.fetch_exchange_requisites,
			"fetch_exchange_requisites",
		).execute({})) as Record<string, unknown>;
		expect(req.orderId).toBe(secondId);
		expect(req.error).toBeUndefined();
	});
});
