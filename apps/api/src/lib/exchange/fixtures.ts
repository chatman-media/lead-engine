import { createHash } from "node:crypto";
import {
	type Db,
	setEncryptedSecret,
	withTenant,
} from "@chatman-media/conversation-engine";
import {
	exchangeRates,
	exchangeRateTiers,
	exchangeSettings,
	kbChunks,
	kbDocuments,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";

export type ExchangeFixtureOfficeKey =
	| "bangkok_asok"
	| "phuket_central"
	| "pattaya_terminal_21"
	| "samui_chaweng";

export interface ExchangeFixtureOffice {
	key: ExchangeFixtureOfficeKey;
	label: string;
	city: string;
	address: string;
	hours: string;
	pickupWindows: string[];
	operatorNote: string;
}

export interface ExchangeFixtureRate {
	key: string;
	asset: string;
	quoteAsset: "THB";
	network: string;
	baseRate: number;
	quoteMode: "multiply" | "divide";
	marginPct: number;
	feeFixedThb: number;
	minAmountFrom: number;
	maxAmountFrom: number;
	autoUpdate: boolean;
}

export interface ExchangeFixtureRateTier {
	key: string;
	asset: string;
	quoteAsset: "THB";
	network: string;
	rangeBasis: "target_thb";
	minAmount: number;
	maxAmount: number | null;
	marketRate: number;
	displayRate: number;
	deviationPct: number;
}

export interface ExchangeFixtureSecret {
	key: string;
	value: string;
	description: string;
}

export interface ExchangeFixtureKbDocument {
	key: string;
	title: string;
	topic: "exchange-fixtures" | "exchange-kyc" | "exchange-payments";
	text: string;
}

export interface SeedExchangeFixturesInput {
	db: Db;
	tenantId: number;
	masterKeyHex: string;
	nowEpoch?: number;
}

export interface SeedExchangeFixturesResult {
	rates: number;
	rateTiers: number;
	secrets: number;
	kbDocuments: number;
	kbChunks: number;
	offices: number;
	scenarioKeys: string[];
}

export const EXCHANGE_FIXTURE_SCENARIO_KEYS = [
	"rub_to_thb_office_pickup",
	"usdt_trc20_to_thb_bank_transfer",
	"usdt_trc20_to_thb_office_cash",
	"kyc_video_review",
	"fiat_payment_receipt_review",
	"rate_changed_before_payment",
	"cancelled_or_changed_order",
] as const;

export const EXCHANGE_FIXTURE_OFFICES: ExchangeFixtureOffice[] = [
	{
		key: "bangkok_asok",
		label: "Bangkok Asok",
		city: "Bangkok",
		address: "Interchange 21, Asok Montri Rd, Level 23, meeting point at lobby cafe",
		hours: "10:00-20:00 ICT daily",
		pickupWindows: ["12:00-14:00", "15:00-17:00", "18:00-20:00"],
		operatorNote: "Operator confirms cash pack and lobby pickup code before customer arrives.",
	},
	{
		key: "phuket_central",
		label: "Phuket Central",
		city: "Phuket",
		address: "Central Phuket Festival, 1st floor, bank zone, customer service desk",
		hours: "11:00-19:00 ICT daily",
		pickupWindows: ["12:00-15:00", "16:00-19:00"],
		operatorNote: "Use for verified customers; require payment proof before pickup slot.",
	},
	{
		key: "pattaya_terminal_21",
		label: "Pattaya Terminal 21",
		city: "Pattaya",
		address: "Terminal 21 Pattaya, Paris floor, information desk meeting point",
		hours: "11:00-18:00 ICT daily",
		pickupWindows: ["12:00-14:00", "15:00-18:00"],
		operatorNote: "Operator must confirm branch cash balance for same-day RUB deals.",
	},
	{
		key: "samui_chaweng",
		label: "Samui Chaweng",
		city: "Koh Samui",
		address: "Chaweng Beach Rd, Central Samui pickup point, gate 2",
		hours: "12:00-18:00 ICT Mon-Sat",
		pickupWindows: ["12:00-14:00", "15:00-18:00"],
		operatorNote: "Same-day pickup only after manual approval; otherwise next business day.",
	},
];

export const EXCHANGE_FIXTURE_RATES: ExchangeFixtureRate[] = [
	{
		key: "usdt_trc20",
		asset: "USDT",
		quoteAsset: "THB",
		network: "trc20",
		baseRate: 36.2,
		quoteMode: "multiply",
		marginPct: 0.85,
		feeFixedThb: 0,
		minAmountFrom: 100,
		maxAmountFrom: 50_000,
		autoUpdate: false,
	},
	{
		key: "usdt_erc20",
		asset: "USDT",
		quoteAsset: "THB",
		network: "erc20",
		baseRate: 36.12,
		quoteMode: "multiply",
		marginPct: 1.1,
		feeFixedThb: 150,
		minAmountFrom: 500,
		maxAmountFrom: 50_000,
		autoUpdate: false,
	},
	{
		key: "usdt_bep20",
		asset: "USDT",
		quoteAsset: "THB",
		network: "bep20",
		baseRate: 36.1,
		quoteMode: "multiply",
		marginPct: 1,
		feeFixedThb: 100,
		minAmountFrom: 300,
		maxAmountFrom: 30_000,
		autoUpdate: false,
	},
	{
		key: "rub_card",
		asset: "RUB",
		quoteAsset: "THB",
		network: "",
		baseRate: 2.58,
		quoteMode: "divide",
		marginPct: 1.25,
		feeFixedThb: 0,
		minAmountFrom: 10_000,
		maxAmountFrom: 3_000_000,
		autoUpdate: false,
	},
	{
		key: "usd_cash",
		asset: "USD",
		quoteAsset: "THB",
		network: "",
		baseRate: 35.95,
		quoteMode: "multiply",
		marginPct: 1.4,
		feeFixedThb: 0,
		minAmountFrom: 100,
		maxAmountFrom: 100_000,
		autoUpdate: false,
	},
];

export const EXCHANGE_FIXTURE_RATE_TIERS: ExchangeFixtureRateTier[] = [
	{
		key: "usdt_trc20_10k_50k",
		asset: "USDT",
		quoteAsset: "THB",
		network: "trc20",
		rangeBasis: "target_thb",
		minAmount: 10_000,
		maxAmount: 50_000,
		marketRate: 36.2,
		displayRate: 35.95,
		deviationPct: -0.6906,
	},
	{
		key: "usdt_trc20_50k_150k",
		asset: "USDT",
		quoteAsset: "THB",
		network: "trc20",
		rangeBasis: "target_thb",
		minAmount: 50_000,
		maxAmount: 150_000,
		marketRate: 36.2,
		displayRate: 36.05,
		deviationPct: -0.4144,
	},
	{
		key: "usdt_trc20_150k_plus",
		asset: "USDT",
		quoteAsset: "THB",
		network: "trc20",
		rangeBasis: "target_thb",
		minAmount: 150_000,
		maxAmount: null,
		marketRate: 36.2,
		displayRate: 36.12,
		deviationPct: -0.221,
	},
	{
		key: "rub_30k_120k",
		asset: "RUB",
		quoteAsset: "THB",
		network: "",
		rangeBasis: "target_thb",
		minAmount: 30_000,
		maxAmount: 120_000,
		marketRate: 2.58,
		displayRate: 2.61,
		deviationPct: 1.1628,
	},
	{
		key: "rub_120k_plus",
		asset: "RUB",
		quoteAsset: "THB",
		network: "",
		rangeBasis: "target_thb",
		minAmount: 120_000,
		maxAmount: null,
		marketRate: 2.58,
		displayRate: 2.6,
		deviationPct: 0.7752,
	},
];

function officesText(): string {
	return EXCHANGE_FIXTURE_OFFICES.map((office) =>
		[
			`${office.label} (${office.key})`,
			`City: ${office.city}`,
			`Address: ${office.address}`,
			`Hours: ${office.hours}`,
			`Pickup windows: ${office.pickupWindows.join(", ")}`,
			`Operator note: ${office.operatorNote}`,
		].join("\n"),
	).join("\n\n");
}

export const EXCHANGE_FIXTURE_SECRETS: ExchangeFixtureSecret[] = [
	{
		key: "exchange_wallet_usdt_trc20",
		value: "TLEdemoUSDTTRC20Wallet1111111111111",
		description: "Static demo USDT/TRC20 wallet for seeded exchange flows.",
	},
	{
		key: "exchange_wallet_usdt_erc20",
		value: "0x1111111111111111111111111111111111EAD488",
		description: "Static demo USDT/ERC20 wallet.",
	},
	{
		key: "exchange_wallet_usdt_bep20",
		value: "0x2222222222222222222222222222222222EAD488",
		description: "Static demo USDT/BEP20 wallet.",
	},
	{
		key: "exchange_binance_id",
		value: "488001337",
		description: "Demo Binance Pay ID for P2P/exchange-account rail.",
	},
	{
		key: "exchange_fiat_payment_url",
		value: "https://pay.example.invalid/lead-engine/rub-sbp-demo",
		description: "Demo RUB SBP payment link.",
	},
	{
		key: "exchange_rub_card_number",
		value: "2200 7000 0000 4888",
		description: "Demo RUB card number.",
	},
	{
		key: "exchange_rub_card_phone",
		value: "+7 999 488-00-00",
		description: "Demo RUB card phone.",
	},
	{
		key: "exchange_rub_card_bank",
		value: "T-Bank",
		description: "Demo RUB source bank.",
	},
	{
		key: "exchange_rub_card_recipient",
		value: "LE Demo Ops",
		description: "Demo RUB card recipient.",
	},
	{
		key: "exchange_operator_telegram",
		value: "@lead_engine_exchange_ops",
		description: "Operator Telegram contact for demo handoffs.",
	},
	{
		key: "exchange_operator_whatsapp",
		value: "+66 80 488 0101",
		description: "Operator WhatsApp contact for demo handoffs.",
	},
	{
		key: "exchange_operator_line",
		value: "leadengine.ops",
		description: "Operator Line contact for Thailand flows.",
	},
	{
		key: "exchange_payout_bank_methods",
		value: [
			"Thai bank transfer: Bangkok Bank, Kasikorn, SCB, Krungsri.",
			"Required: bank name, account holder, account number or PromptPay phone.",
			"Operator verifies payment before transfer; bot must not promise instant payout.",
		].join("\n"),
		description: "THB bank payout instructions.",
	},
	{
		key: "exchange_payout_cash_methods",
		value: [
			"Office cash pickup is available only after payment verification.",
			"Available offices:",
			officesText(),
			"Courier cash is operator-approved only for verified customers.",
			"Cardless ATM code is created by operator/provider and must never be invented by AI.",
		].join("\n\n"),
		description: "THB cash pickup and office instructions.",
	},
	{
		key: "exchange_aml_policy",
		value: [
			"All crypto deposits are AML-checked before THB payout.",
			"High-risk source, mixer exposure, sanctioned wallet, mismatched amount, or unknown sender requires operator review.",
			"Bot must say verification is pending; it must not mark payment complete by itself.",
		].join("\n"),
		description: "AML policy for exchange demo.",
	},
	{
		key: "exchange_kyc_policy",
		value: [
			"KYC is required for first-time clients, RUB payments above 100000 RUB, crypto deals above 50000 THB, third-party payer, or operator request.",
			"Accepted evidence: passport/ID photo plus short video with full name, date, and exchange direction.",
			"Video/document media must be forwarded to operator or external verification service before order completion.",
		].join("\n"),
		description: "KYC policy for exchange demo.",
	},
	{
		key: "exchange_working_hours",
		value: "10:00-20:00 ICT daily. After-hours requests are queued; urgent payout needs operator approval.",
		description: "Demo exchange business hours.",
	},
	{
		key: "exchange_office_address",
		value: officesText(),
		description: "Structured office list serialized as text for current business-info tool.",
	},
];

export const EXCHANGE_FIXTURE_KB_DOCUMENTS: ExchangeFixtureKbDocument[] = [
	{
		key: "office-pickup",
		title: "Exchange fixture: office cash pickup",
		topic: "exchange-fixtures",
		text: [
			"Office cash pickup flow.",
			"Customer can choose Bangkok Asok, Phuket Central, Pattaya Terminal 21, or Samui Chaweng.",
			"Before pickup, payment must be verified and operator must confirm cash pack availability.",
			"AI may show available office names, hours, and pickup windows from business info.",
			"AI must not invent pickup codes. If code is missing or expired, escalate to operator.",
		].join("\n"),
	},
	{
		key: "rub-payment-proof",
		title: "Exchange fixture: RUB payment proof review",
		topic: "exchange-payments",
		text: [
			"RUB payment by card or SBP cannot be auto-confirmed.",
			"After customer sends receipt, save source bank, payer name, amount, and reference if visible.",
			"Reply that the receipt is being checked by operator.",
			"Do not say money is received until operator marks the order paid.",
		].join("\n"),
	},
	{
		key: "kyc-video",
		title: "Exchange fixture: KYC video and documents",
		topic: "exchange-kyc",
		text: [
			"KYC media handling.",
			"If customer sends document, photo, video, or Telegram circle for verification, it must become an operator/external-verification handoff.",
			"Required context: customer, order or intended exchange direction, media reference, and decision needed.",
			"AI can acknowledge receipt and explain that verification is pending.",
		].join("\n"),
	},
	{
		key: "rate-change",
		title: "Exchange fixture: stale rate and changed order",
		topic: "exchange-fixtures",
		text: [
			"Rates and requisites have TTL.",
			"If customer changes amount, asset, network, payment rail, or payout method, recompute quote and recreate or update the order path.",
			"If TTL expired, do not use old requisites; recalculate and issue fresh instructions.",
		].join("\n"),
	},
	{
		key: "operator-escalation",
		title: "Exchange fixture: operator escalation rules",
		topic: "exchange-fixtures",
		text: [
			"Escalate to operator when KYC is needed, fiat receipt needs review, AML risk is high, office cash availability is unknown, payout code is missing, customer asks for exception, or system lacks configured requisites.",
			"Escalation message must include a concrete reason and the next decision needed.",
			"A generic 'operator will contact you' is not enough for internal QA.",
		].join("\n"),
	},
];

function stableHash(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function roughTokenCount(input: string): number {
	return input.split(/\s+/).filter(Boolean).length;
}

export async function seedExchangeFixtures(
	input: SeedExchangeFixturesInput,
): Promise<SeedExchangeFixturesResult> {
	const now = input.nowEpoch ?? Math.floor(Date.now() / 1000);

	await withTenant(input.db, input.tenantId, async (tx) => {
		await tx
			.insert(exchangeSettings)
			.values({
				tenantId: input.tenantId,
				rateRefreshSec: 300,
				feedStaleSec: 900,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: exchangeSettings.tenantId,
				set: { rateRefreshSec: 300, feedStaleSec: 900, updatedAt: now },
			});

		for (const rate of EXCHANGE_FIXTURE_RATES) {
			await tx
				.insert(exchangeRates)
				.values({
					tenantId: input.tenantId,
					asset: rate.asset,
					quoteAsset: rate.quoteAsset,
					network: rate.network,
					baseRate: rate.baseRate,
					quoteMode: rate.quoteMode,
					marginPct: rate.marginPct,
					feeFixedThb: rate.feeFixedThb,
					minAmountFrom: rate.minAmountFrom,
					maxAmountFrom: rate.maxAmountFrom,
					isActive: true,
					autoUpdate: rate.autoUpdate,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [
						exchangeRates.tenantId,
						exchangeRates.asset,
						exchangeRates.quoteAsset,
						exchangeRates.network,
					],
					set: {
						baseRate: rate.baseRate,
						quoteMode: rate.quoteMode,
						marginPct: rate.marginPct,
						feeFixedThb: rate.feeFixedThb,
						minAmountFrom: rate.minAmountFrom,
						maxAmountFrom: rate.maxAmountFrom,
						isActive: true,
						autoUpdate: rate.autoUpdate,
						updatedAt: now,
					},
				});
		}

		for (const tier of EXCHANGE_FIXTURE_RATE_TIERS) {
			await tx
				.insert(exchangeRateTiers)
				.values({
					tenantId: input.tenantId,
					asset: tier.asset,
					quoteAsset: tier.quoteAsset,
					network: tier.network,
					rangeBasis: tier.rangeBasis,
					minAmount: tier.minAmount,
					maxAmount: tier.maxAmount,
					marketRate: tier.marketRate,
					displayRate: tier.displayRate,
					deviationPct: tier.deviationPct,
					formulaJson: JSON.stringify({
						fixtureKey: tier.key,
						source: "exchange-fixtures",
					}),
					isActive: true,
					approvedAt: now,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [
						exchangeRateTiers.tenantId,
						exchangeRateTiers.asset,
						exchangeRateTiers.quoteAsset,
						exchangeRateTiers.network,
						exchangeRateTiers.rangeBasis,
						exchangeRateTiers.minAmount,
					],
					set: {
						maxAmount: tier.maxAmount,
						marketRate: tier.marketRate,
						displayRate: tier.displayRate,
						deviationPct: tier.deviationPct,
						formulaJson: JSON.stringify({
							fixtureKey: tier.key,
							source: "exchange-fixtures",
						}),
						isActive: true,
						approvedAt: now,
						updatedAt: now,
					},
				});
		}

		for (const secret of EXCHANGE_FIXTURE_SECRETS) {
			await setEncryptedSecret({
				db: tx as Db,
				tenantId: input.tenantId,
				key: secret.key,
				value: secret.value,
				masterKeyHex: input.masterKeyHex,
				nowEpoch: now,
			});
		}

		for (const doc of EXCHANGE_FIXTURE_KB_DOCUMENTS) {
			const source = `exchange-fixtures:${input.tenantId}:${doc.key}`;
			const contentHash = stableHash(doc.text);
			await tx
				.delete(kbDocuments)
				.where(and(eq(kbDocuments.tenantId, input.tenantId), eq(kbDocuments.source, source)));
			const [inserted] = await tx
				.insert(kbDocuments)
				.values({
					tenantId: input.tenantId,
					source,
					title: doc.title,
					contentHash,
					topic: doc.topic,
					scopeType: "global",
					createdAt: now,
				})
				.returning({ id: kbDocuments.id });
			if (!inserted) throw new Error(`failed to seed KB fixture ${doc.key}`);
			await tx.insert(kbChunks).values({
				tenantId: input.tenantId,
				documentId: inserted.id,
				chunkIndex: 0,
				text: doc.text,
				tokenCount: roughTokenCount(doc.text),
				embedding: null,
				createdAt: now,
			});
		}
	});

	return {
		rates: EXCHANGE_FIXTURE_RATES.length,
		rateTiers: EXCHANGE_FIXTURE_RATE_TIERS.length,
		secrets: EXCHANGE_FIXTURE_SECRETS.length,
		kbDocuments: EXCHANGE_FIXTURE_KB_DOCUMENTS.length,
		kbChunks: EXCHANGE_FIXTURE_KB_DOCUMENTS.length,
		offices: EXCHANGE_FIXTURE_OFFICES.length,
		scenarioKeys: [...EXCHANGE_FIXTURE_SCENARIO_KEYS],
	};
}
