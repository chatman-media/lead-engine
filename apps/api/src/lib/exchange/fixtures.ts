import { createHash } from "node:crypto";
import {
	type Db,
	QUOTE_CURRENCY,
	type QuoteCurrency,
	resolveQuoteCurrency,
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

export type ExchangeFixtureOfficeKey = string;

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
	quoteAsset: string;
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
	quoteAsset: string;
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
	/** Котируемая валюта тенанта (PHP/THB/…); пусто → платформенный дефолт. */
	quoteAsset?: string | null;
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

const EXCHANGE_FIXTURE_OFFICES_THB: ExchangeFixtureOffice[] = [
	{
		key: "bangkok_asok",
		label: "Bangkok Asok",
		city: "Bangkok",
		address:
			"Interchange 21, Asok Montri Rd, Level 23, meeting point at lobby cafe",
		hours: "10:00-20:00 ICT daily",
		pickupWindows: ["12:00-14:00", "15:00-17:00", "18:00-20:00"],
		operatorNote:
			"Operator confirms cash pack and lobby pickup code before customer arrives.",
	},
	{
		key: "phuket_central",
		label: "Phuket Central",
		city: "Phuket",
		address:
			"Central Phuket Festival, 1st floor, bank zone, customer service desk",
		hours: "11:00-19:00 ICT daily",
		pickupWindows: ["12:00-15:00", "16:00-19:00"],
		operatorNote:
			"Use for verified customers; require payment proof before pickup slot.",
	},
	{
		key: "pattaya_terminal_21",
		label: "Pattaya Terminal 21",
		city: "Pattaya",
		address: "Terminal 21 Pattaya, Paris floor, information desk meeting point",
		hours: "11:00-18:00 ICT daily",
		pickupWindows: ["12:00-14:00", "15:00-18:00"],
		operatorNote:
			"Operator must confirm branch cash balance for same-day RUB deals.",
	},
	{
		key: "samui_chaweng",
		label: "Samui Chaweng",
		city: "Koh Samui",
		address: "Chaweng Beach Rd, Central Samui pickup point, gate 2",
		hours: "12:00-18:00 ICT Mon-Sat",
		pickupWindows: ["12:00-14:00", "15:00-18:00"],
		operatorNote:
			"Same-day pickup only after manual approval; otherwise next business day.",
	},
];

const EXCHANGE_FIXTURE_OFFICES_PHP: ExchangeFixtureOffice[] = [
	{
		key: "manila_makati",
		label: "Manila Makati",
		city: "Manila",
		address:
			"Greenbelt 3, Ayala Center, Makati, meeting point at concierge desk",
		hours: "10:00-20:00 PHT daily",
		pickupWindows: ["12:00-14:00", "15:00-17:00", "18:00-20:00"],
		operatorNote:
			"Operator confirms cash pack and lobby pickup code before customer arrives.",
	},
	{
		key: "manila_bgc",
		label: "Manila BGC",
		city: "Taguig",
		address: "SM Aura Premier, BGC, ground floor, customer service desk",
		hours: "11:00-19:00 PHT daily",
		pickupWindows: ["12:00-15:00", "16:00-19:00"],
		operatorNote:
			"Use for verified customers; require payment proof before pickup slot.",
	},
	{
		key: "cebu_it_park",
		label: "Cebu IT Park",
		city: "Cebu",
		address:
			"Ayala Malls Central Bloc, Cebu IT Park, information desk meeting point",
		hours: "11:00-18:00 PHT daily",
		pickupWindows: ["12:00-14:00", "15:00-18:00"],
		operatorNote:
			"Operator must confirm branch cash balance for same-day RUB deals.",
	},
	{
		key: "angeles_clark",
		label: "Angeles Clark",
		city: "Angeles",
		address: "SM City Clark, main entrance pickup point, gate 2",
		hours: "12:00-18:00 PHT Mon-Sat",
		pickupWindows: ["12:00-14:00", "15:00-18:00"],
		operatorNote:
			"Same-day pickup only after manual approval; otherwise next business day.",
	},
];

export function exchangeFixtureOffices(
	quoteAsset: string = QUOTE_CURRENCY.code,
): ExchangeFixtureOffice[] {
	return quoteAsset === "PHP"
		? EXCHANGE_FIXTURE_OFFICES_PHP
		: EXCHANGE_FIXTURE_OFFICES_THB;
}

/** @deprecated Снапшот для платформенного дефолта; для per-tenant — exchangeFixtureOffices(). */
export const EXCHANGE_FIXTURE_OFFICES: ExchangeFixtureOffice[] =
	exchangeFixtureOffices();

const EXCHANGE_FIXTURE_RATES_THB: ExchangeFixtureRate[] = [
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

// PHP-набор (Филиппины): base_rate близок к рынку (USDT→PHP ≈ 61–62, RUB за 1 PHP ≈ 1.43);
// autoUpdate: true — фид сам ведёт base_rate, демо показывает живую синхронизацию.
const EXCHANGE_FIXTURE_RATES_PHP: ExchangeFixtureRate[] = [
	{
		key: "usdt_trc20",
		asset: "USDT",
		quoteAsset: "PHP",
		network: "trc20",
		baseRate: 61.5,
		quoteMode: "multiply",
		marginPct: 0.85,
		feeFixedThb: 0,
		minAmountFrom: 100,
		maxAmountFrom: 50_000,
		autoUpdate: true,
	},
	{
		key: "usdt_erc20",
		asset: "USDT",
		quoteAsset: "PHP",
		network: "erc20",
		baseRate: 61.3,
		quoteMode: "multiply",
		marginPct: 1.1,
		feeFixedThb: 250,
		minAmountFrom: 500,
		maxAmountFrom: 50_000,
		autoUpdate: true,
	},
	{
		key: "usdt_bep20",
		asset: "USDT",
		quoteAsset: "PHP",
		network: "bep20",
		baseRate: 61.2,
		quoteMode: "multiply",
		marginPct: 1,
		feeFixedThb: 150,
		minAmountFrom: 300,
		maxAmountFrom: 30_000,
		autoUpdate: true,
	},
	{
		key: "rub_card",
		asset: "RUB",
		quoteAsset: "PHP",
		network: "",
		baseRate: 1.43,
		quoteMode: "divide",
		marginPct: 1.25,
		feeFixedThb: 0,
		minAmountFrom: 10_000,
		maxAmountFrom: 3_000_000,
		autoUpdate: true,
	},
	{
		key: "usd_cash",
		asset: "USD",
		quoteAsset: "PHP",
		network: "",
		baseRate: 61.4,
		quoteMode: "multiply",
		marginPct: 1.4,
		feeFixedThb: 0,
		minAmountFrom: 100,
		maxAmountFrom: 100_000,
		autoUpdate: true,
	},
		{
			key: "php_to_rub",
			asset: "PHP",
			quoteAsset: "RUB",
			network: "",
			// RUB за 1 PHP (тот же кросс, что rub_card). multiply: gross = PHP * eff.
			baseRate: 1.43,
			quoteMode: "multiply",
			marginPct: 2,
			feeFixedThb: 0,
			minAmountFrom: 5_000,
			maxAmountFrom: 2_000_000,
			// Фид не котирует PHP как source-актив → курс ведёт оператор вручную.
			autoUpdate: false,
		},
];

export function exchangeFixtureRates(
	quoteAsset: string = QUOTE_CURRENCY.code,
): ExchangeFixtureRate[] {
	return quoteAsset === "PHP"
		? EXCHANGE_FIXTURE_RATES_PHP
		: EXCHANGE_FIXTURE_RATES_THB;
}

/** @deprecated Снапшот для платформенного дефолта; для per-tenant — exchangeFixtureRates(). */
export const EXCHANGE_FIXTURE_RATES: ExchangeFixtureRate[] =
	exchangeFixtureRates();

const EXCHANGE_FIXTURE_RATE_TIERS_THB: ExchangeFixtureRateTier[] = [
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

// Диапазоны в PHP ≈ ×2 от THB (курс к USD ниже). rangeBasis 'target_thb' —
// внутренний код «диапазон по целевой котируемой валюте», не переименовывается.
const EXCHANGE_FIXTURE_RATE_TIERS_PHP: ExchangeFixtureRateTier[] = [
	{
		key: "usdt_trc20_20k_100k",
		asset: "USDT",
		quoteAsset: "PHP",
		network: "trc20",
		rangeBasis: "target_thb",
		minAmount: 20_000,
		maxAmount: 100_000,
		marketRate: 61.5,
		displayRate: 61.0,
		deviationPct: -0.813,
	},
	{
		key: "usdt_trc20_100k_300k",
		asset: "USDT",
		quoteAsset: "PHP",
		network: "trc20",
		rangeBasis: "target_thb",
		minAmount: 100_000,
		maxAmount: 300_000,
		marketRate: 61.5,
		displayRate: 61.2,
		deviationPct: -0.4878,
	},
	{
		key: "usdt_trc20_300k_plus",
		asset: "USDT",
		quoteAsset: "PHP",
		network: "trc20",
		rangeBasis: "target_thb",
		minAmount: 300_000,
		maxAmount: null,
		marketRate: 61.5,
		displayRate: 61.35,
		deviationPct: -0.2439,
	},
	{
		key: "rub_60k_240k",
		asset: "RUB",
		quoteAsset: "PHP",
		network: "",
		rangeBasis: "target_thb",
		minAmount: 60_000,
		maxAmount: 240_000,
		marketRate: 1.43,
		displayRate: 1.4543,
		deviationPct: 1.7,
	},
	{
		key: "rub_240k_plus",
		asset: "RUB",
		quoteAsset: "PHP",
		network: "",
		rangeBasis: "target_thb",
		minAmount: 240_000,
		maxAmount: null,
		marketRate: 1.43,
		displayRate: 1.4422,
		deviationPct: 0.85,
	},
		{
			key: "php_to_rub_60k_240k",
			asset: "PHP",
			quoteAsset: "RUB",
			network: "",
			rangeBasis: "target_thb",
			minAmount: 60_000,
			maxAmount: 240_000,
			marketRate: 1.43,
			// eff = base*(1-0.015): клиент получает меньше RUB за PHP (спред обменнику).
			displayRate: 1.4086,
			deviationPct: -1.5,
		},
		{
			key: "php_to_rub_240k_plus",
			asset: "PHP",
			quoteAsset: "RUB",
			network: "",
			rangeBasis: "target_thb",
			minAmount: 240_000,
			maxAmount: null,
			marketRate: 1.43,
			// Крупные суммы — спред уже (deviation ближе к 0).
			displayRate: 1.4186,
			deviationPct: -0.8,
		},
];

export function exchangeFixtureRateTiers(
	quoteAsset: string = QUOTE_CURRENCY.code,
): ExchangeFixtureRateTier[] {
	return quoteAsset === "PHP"
		? EXCHANGE_FIXTURE_RATE_TIERS_PHP
		: EXCHANGE_FIXTURE_RATE_TIERS_THB;
}

/** @deprecated Снапшот для платформенного дефолта; для per-tenant — exchangeFixtureRateTiers(). */
export const EXCHANGE_FIXTURE_RATE_TIERS: ExchangeFixtureRateTier[] =
	exchangeFixtureRateTiers();

function officesText(offices: ExchangeFixtureOffice[]): string {
	return offices
		.map((office) =>
			[
				`${office.label} (${office.key})`,
				`City: ${office.city}`,
				`Address: ${office.address}`,
				`Hours: ${office.hours}`,
				`Pickup windows: ${office.pickupWindows.join(", ")}`,
				`Operator note: ${office.operatorNote}`,
			].join("\n"),
		)
		.join("\n\n");
}

export function exchangeFixtureSecrets(
	currency: QuoteCurrency = QUOTE_CURRENCY,
): ExchangeFixtureSecret[] {
	return [
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
			value: currency.code === "PHP" ? "+63 917 488 0101" : "+66 80 488 0101",
			description: "Operator WhatsApp contact for demo handoffs.",
		},
		{
			key: "exchange_operator_line",
			// Филиппины: Line не в ходу — кладём Viber-контакт под тем же ключом.
			value:
				currency.code === "PHP" ? "viber: +63 917 488 0101" : "leadengine.ops",
			description:
				currency.code === "PHP"
					? "Operator Viber contact for Philippines flows."
					: "Operator Line contact for Thailand flows.",
		},
		{
			key: "exchange_payout_bank_methods",
			value:
				currency.code === "PHP"
					? [
							"Local bank transfer: BDO, BPI, Metrobank, UnionBank; e-wallets GCash and Maya.",
							"Required: bank/e-wallet name, account holder, account number or GCash phone.",
							"Operator verifies payment before transfer; bot must not promise instant payout.",
						].join("\n")
					: [
							"Thai bank transfer: Bangkok Bank, Kasikorn, SCB, Krungsri.",
							"Required: bank name, account holder, account number or PromptPay phone.",
							"Operator verifies payment before transfer; bot must not promise instant payout.",
						].join("\n"),
			description: `${currency.code} bank payout instructions.`,
		},
		{
			key: "exchange_payout_cash_methods",
			value: [
				"Office cash pickup is available only after payment verification.",
				"Available offices:",
				officesText(exchangeFixtureOffices(currency.code)),
				"Courier cash is operator-approved only for verified customers.",
				"Cardless ATM code is created by operator/provider and must never be invented by AI.",
			].join("\n\n"),
			description: `${currency.code} cash pickup and office instructions.`,
		},
		{
			key: "exchange_aml_policy",
			value: [
				`All crypto deposits are AML-checked before ${currency.code} payout.`,
				"High-risk source, mixer exposure, sanctioned wallet, mismatched amount, or unknown sender requires operator review.",
				"Bot must say verification is pending; it must not mark payment complete by itself.",
			].join("\n"),
			description: "AML policy for exchange demo.",
		},
		{
			key: "exchange_kyc_policy",
			value: [
				`KYC is required for first-time clients, RUB payments above 100000 RUB, crypto deals above ${currency.code === "PHP" ? "100000 PHP" : "50000 THB"}, third-party payer, or operator request.`,
				"Accepted evidence: passport/ID photo plus short video with full name, date, and exchange direction.",
				"Video/document media must be forwarded to operator or external verification service before order completion.",
			].join("\n"),
			description: "KYC policy for exchange demo.",
		},
		{
			key: "exchange_working_hours",
			value: `10:00-20:00 ${currency.code === "PHP" ? "PHT" : "ICT"} daily. After-hours requests are queued; urgent payout needs operator approval.`,
			description: "Demo exchange business hours.",
		},
		{
			key: "exchange_office_address",
			value: officesText(exchangeFixtureOffices(currency.code)),
			description:
				"Structured office list serialized as text for current business-info tool.",
		},
	];
}

/** @deprecated Снапшот для платформенного дефолта; для per-tenant — exchangeFixtureSecrets(). */
export const EXCHANGE_FIXTURE_SECRETS: ExchangeFixtureSecret[] =
	exchangeFixtureSecrets();

export function exchangeFixtureKbDocuments(
	currency: QuoteCurrency = QUOTE_CURRENCY,
): ExchangeFixtureKbDocument[] {
	const officeNames = exchangeFixtureOffices(currency.code)
		.map((office) => office.label)
		.join(", ");
	return [
		{
			key: "office-pickup",
			title: "Exchange fixture: office cash pickup",
			topic: "exchange-fixtures",
			text: [
				"Office cash pickup flow.",
				`Customer can choose ${officeNames}.`,
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
}

/** @deprecated Снапшот для платформенного дефолта; для per-tenant — exchangeFixtureKbDocuments(). */
export const EXCHANGE_FIXTURE_KB_DOCUMENTS: ExchangeFixtureKbDocument[] =
	exchangeFixtureKbDocuments();

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
	const currency = resolveQuoteCurrency(input.quoteAsset);
	const fixtureRates = exchangeFixtureRates(currency.code);
	const fixtureTiers = exchangeFixtureRateTiers(currency.code);
	const fixtureSecrets = exchangeFixtureSecrets(currency);
	const fixtureKbDocuments = exchangeFixtureKbDocuments(currency);
	const fixtureOffices = exchangeFixtureOffices(currency.code);

	await withTenant(input.db, input.tenantId, async (tx) => {
		await tx
			.insert(exchangeSettings)
			.values({
				tenantId: input.tenantId,
				rateRefreshSec: 300,
				feedStaleSec: 900,
				quoteAsset: currency.code,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: exchangeSettings.tenantId,
				set: {
					rateRefreshSec: 300,
					feedStaleSec: 900,
					quoteAsset: currency.code,
					updatedAt: now,
				},
			});

		for (const rate of fixtureRates) {
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

		for (const tier of fixtureTiers) {
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

		for (const secret of fixtureSecrets) {
			await setEncryptedSecret({
				db: tx as Db,
				tenantId: input.tenantId,
				key: secret.key,
				value: secret.value,
				masterKeyHex: input.masterKeyHex,
				nowEpoch: now,
			});
		}

		for (const doc of fixtureKbDocuments) {
			const source = `exchange-fixtures:${input.tenantId}:${doc.key}`;
			const contentHash = stableHash(doc.text);
			await tx
				.delete(kbDocuments)
				.where(
					and(
						eq(kbDocuments.tenantId, input.tenantId),
						eq(kbDocuments.source, source),
					),
				);
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
		rates: fixtureRates.length,
		rateTiers: fixtureTiers.length,
		secrets: fixtureSecrets.length,
		kbDocuments: fixtureKbDocuments.length,
		kbChunks: fixtureKbDocuments.length,
		offices: fixtureOffices.length,
		scenarioKeys: [...EXCHANGE_FIXTURE_SCENARIO_KEYS],
	};
}
