#!/usr/bin/env bun
/**
 * Seed a live-ish exchange demo tenant for client walkthroughs.
 *
 * Creates/updates:
 *   - tenant exchange-demo (active)
 *   - owner/operator admins (password: test1234 by default)
 *   - web channel, optional Telegram bot channel
 *   - chat LLM config needed by the onboarding gate
 *   - exchange_v1 funnel via the "exchange" seed template
 *   - deterministic exchange fixtures: rates, approved tiers, requisites, offices, KB
 *   - exchange sample KB from apps/api/kb-samples/exchange
 *   - demo leads/conversations/orders across the exchange workflow
 *
 * Usage:
 *   DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
 *   PLATFORM_MASTER_KEY=<64hex> \
 *   bun run --cwd apps/api seed:exchange-demo
 *
 * With tenant-scoped chat LLM config for dialog simulator:
 *   EXCHANGE_DEMO_LLM_PROVIDER=openrouter \
 *   EXCHANGE_DEMO_LLM_MODEL=openai/gpt-4o-mini \
 *   EXCHANGE_DEMO_LLM_API_KEY=<openrouter-key> \
 *   bun run --cwd apps/api seed:exchange-demo
 *
 * With Telegram channel row + encrypted token:
 *   EXCHANGE_DEMO_TELEGRAM_BOT_TOKEN=123:ABC... \
 *   EXCHANGE_DEMO_TELEGRAM_BOT_USERNAME=my_demo_bot \
 *   PLATFORM_PUBLIC_URL=https://api.example.com \
 *   TELEGRAM_WEBHOOK_SECRET=secret \
 *   bun run --cwd apps/api seed:exchange-demo -- --set-telegram-webhook
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
	type Db,
	type QuoteCurrency,
	resolveQuoteCurrency,
	setEncryptedSecret,
	withTenant,
} from "@chatman-media/conversation-engine";
import {
	admins,
	channelIdentities,
	channels,
	contacts,
	conversations,
	directorHooks,
	exchangeOrders,
	exchangeRates,
	exchangeRateTiers,
	funnels,
	kbChunks,
	kbDocuments,
	leadFieldValues,
	leads,
	llmProviderConfigs,
	messages,
	schema,
	serviceCatalogItems,
	stageDefinitions,
	stageFields,
	styles,
	tenants,
} from "@chatman-media/storage";
import { fastTraderPas } from "@chatman-media/vertical-exchange";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { hashPassword } from "../src/lib/auth.ts";
import { seedExchangeFixtures } from "../src/lib/exchange/fixtures.ts";
import { fetchMarketBaseRate } from "../src/lib/exchange/rate-feed.ts";
import { seedFunnelByKey } from "../src/routes/admin-funnel.ts";

const DEFAULT_SLUG = "exchange-demo";
const DEFAULT_OWNER_EMAIL = "owner@exchange.demo";
const DEFAULT_OPERATOR_EMAIL = "operator@exchange.demo";
const DEFAULT_PASSWORD = "test1234";
const DEFAULT_LLM_PROVIDER = "openai";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";
const DEMO_SEED = "exchange-demo";
const MASTER_KEY_PLACEHOLDER = "<64hex>";

type Role = "superadmin" | "manager";
type MessageRole = "user" | "assistant" | "human";
type LlmProvider = "openai" | "openrouter" | "ollama" | "anthropic";

interface Args {
	slug: string;
	ownerEmail: string;
	operatorEmail: string;
	password: string;
	telegramBotToken: string | null;
	telegramBotUsername: string | null;
	llmProvider: LlmProvider;
	llmModel: string;
	llmApiKey: string | null;
	llmBaseUrl: string | null;
	publicUrl: string | null;
	setTelegramWebhook: boolean;
	/** Котируемая валюта демо-тенанта; пусто → платформенный дефолт (PHP). */
	quoteAsset: string | null;
	/** Имя бренда для веб-канала/виджета (--brand / EXCHANGE_DEMO_BRAND). */
	brand: string;
}

interface DemoMessage {
	role: MessageRole;
	text: string;
}

interface DemoOrder {
	status: "awaiting_payment" | "paid" | "payout" | "completed" | "cancelled";
	direction: string;
	assetFrom: string;
	network: string;
	amountFrom: number;
	rate: number;
	amountToThb: number;
	paymentMethod:
		| "crypto_transfer"
		| "sbp_qr"
		| "card_transfer"
		| "bank_transfer"
		| "cash";
	paymentRail: string;
	payoutMethod:
		| "office_cash"
		| "cardless_atm"
		| "courier_cash"
		| "thai_bank_transfer"
		| "atm";
	payoutLocation?: string;
	requisitesJson?: Record<string, unknown>;
	proofJson?: Record<string, unknown>;
	riskJson?: Record<string, unknown>;
	payoutCode?: string;
}

interface DemoLead {
	key: string;
	stage: string;
	name: string;
	telegramId: string;
	operator?: boolean;
	fields: Record<string, unknown>;
	messages: DemoMessage[];
	order?: DemoOrder;
}

// Демо-данные параметризованы котируемой валютой тенанта (--quote-asset /
// EXCHANGE_DEMO_QUOTE_ASSET; пусто → платформенный дефолт, сейчас PHP).
// Курсы в диалогах берутся с ЖИВОГО рынка на момент сидинга (см.
// freshenSeededRates); значения здесь — офлайн-фоллбэк, если фид недоступен.
// Суммы считаются от курсов, чтобы диалоги и заявки были согласованы.
interface DemoQuoteParams {
	/** Курс quote за 1 USDT в демо-диалогах (фоллбэк без сети). */
	usdtRate: number;
	/** Курс в отменённой заявке (чуть хуже; фоллбэк без сети). */
	usdtRateCancelled: number;
	/** RUB за 1 единицу quote (фоллбэк без сети). */
	rubRate: number;
	/** «Нужно N <quote>» в KYC-диалоге. */
	kycTargetQuote: number;
	/** Сумма выдачи в завершённой заявке. */
	completedQuote: number;
	office1Label: string;
	office1Key: string;
	office2Label: string;
	office2Key: string;
}

const DEMO_QUOTE_PARAMS: Record<string, DemoQuoteParams> = {
	THB: {
		usdtRate: 32.7,
		usdtRateCancelled: 32.6,
		rubRate: 2.22,
		kycTargetQuote: 180_000,
		completedQuote: 50_000,
		office1Label: "Bangkok Asok",
		office1Key: "bangkok_asok",
		office2Label: "Phuket Central",
		office2Key: "phuket_central",
	},
	PHP: {
		usdtRate: 61.2,
		usdtRateCancelled: 61.0,
		rubRate: 1.18,
		kycTargetQuote: 340_000,
		completedQuote: 100_000,
		office1Label: "Manila Makati",
		office1Key: "manila_makati",
		office2Label: "Cebu IT Park",
		office2Key: "cebu_it_park",
	},
};

/** Живые демо-курсы, выведенные из рыночного фида на момент сидинга. */
interface LiveDemoRates {
	/** Display-курс USDT (средний тир: рынок − 0.4878%). */
	usdtRate: number;
	/** Display-курс отменённой заявки (нижний тир: рынок − 0.813%). */
	usdtRateCancelled: number;
	/** RUB за 1 quote (тир 60–240k: рынок + 1.7094%). */
	rubRate: number;
}

const fmtAmount = (n: number) => n.toLocaleString("ru-RU");

function roundTo(n: number, dp: number): number {
	const f = 10 ** dp;
	return Math.round(n * f) / f;
}

/**
 * Освежает посеянные курсы живым рынком: base_rate строк тенанта в его валюте
 * + market/display тиров (рынок × (1 + deviationPct/100)). Возвращает живые
 * курсы для демо-диалогов; null — фид недоступен (остаёмся на статических
 * фоллбэках DEMO_QUOTE_PARAMS, табло поправит планировщик после старта api).
 */
async function freshenSeededRates(input: {
	db: Db;
	tenantId: number;
	currency: QuoteCurrency;
	now: number;
}): Promise<LiveDemoRates | null> {
	try {
		const usdtMarket = await fetchMarketBaseRate(
			"USDT",
			"multiply",
			input.currency.code,
		);
		const rubMarket = await fetchMarketBaseRate(
			"RUB",
			"divide",
			input.currency.code,
		);
		const usdMarket = await fetchMarketBaseRate(
			"USD",
			"multiply",
			input.currency.code,
		);
		if (!usdtMarket || !rubMarket) return null;

		const marketByAsset: Record<string, number> = {
			USDT: usdtMarket,
			RUB: rubMarket,
			...(usdMarket ? { USD: usdMarket } : {}),
		};

		await withTenant(input.db, input.tenantId, async (tx) => {
			for (const [asset, market] of Object.entries(marketByAsset)) {
				await tx
					.update(exchangeRates)
					.set({ baseRate: roundTo(market, 6), updatedAt: input.now })
					.where(
						and(
							eq(exchangeRates.tenantId, input.tenantId),
							eq(exchangeRates.asset, asset),
							eq(exchangeRates.quoteAsset, input.currency.code),
						),
					);
			}
			const tiers = await tx
				.select({
					id: exchangeRateTiers.id,
					asset: exchangeRateTiers.asset,
					deviationPct: exchangeRateTiers.deviationPct,
				})
				.from(exchangeRateTiers)
				.where(
					and(
						eq(exchangeRateTiers.tenantId, input.tenantId),
						eq(exchangeRateTiers.quoteAsset, input.currency.code),
					),
				);
			for (const tier of tiers) {
				const market = marketByAsset[tier.asset];
				if (!market) continue;
				await tx
					.update(exchangeRateTiers)
					.set({
						marketRate: roundTo(market, 6),
						displayRate: roundTo(
							market * (1 + Number(tier.deviationPct) / 100),
							2,
						),
						updatedAt: input.now,
					})
					.where(
						and(
							eq(exchangeRateTiers.tenantId, input.tenantId),
							eq(exchangeRateTiers.id, tier.id),
						),
					);
			}
		});

		// Демо-диалоги показывают те же display-курсы, что и тир-карта
		// (девиации совпадают с PHP/THB-тирами фикстур): USDT — средний тир
		// (−0.4878%), отменённая заявка — нижний (−0.813%), RUB — тир 60–240k
		// (+1.7094%).
		return {
			usdtRate: roundTo(usdtMarket * (1 - 0.004878), 2),
			usdtRateCancelled: roundTo(usdtMarket * (1 - 0.00813), 2),
			rubRate: roundTo(rubMarket * 1.017094, 2),
		};
	} catch (err) {
		console.warn(
			"[seed-exchange-demo] live rate freshen skipped:",
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

function buildSampleLeads(
	currency: QuoteCurrency,
	live: LiveDemoRates | null,
): DemoLead[] {
	const QUOTE = currency.code;
	const QUOTE_WORD_PL = currency.tabloWord.toLowerCase(); // «баты»/«песо»
	const base: DemoQuoteParams =
		DEMO_QUOTE_PARAMS[QUOTE] ?? (DEMO_QUOTE_PARAMS.PHP as DemoQuoteParams);
	const P: DemoQuoteParams = live ? { ...base, ...live } : base;

	const QUOTE_CONFIRMED_TO = Math.round(2000 * P.usdtRate);
	const KYC_FROM_RUB = Math.round(P.kycTargetQuote * P.rubRate);
	const REQUISITES_TO = Math.round(1000 * P.usdtRate);
	const PROOF_TO = Math.round(335 * P.usdtRate);
	const COMPLETED_FROM_RUB = Math.round(P.completedQuote * P.rubRate);
	const CANCELLED_TO = Math.round(150 * P.usdtRateCancelled);

	return [
		{
			key: "rate-request",
			stage: "exchange_request",
			name: "Илья Новиков",
			telegramId: "demo_exchange_001",
			fields: {
				asset_from: "usdt",
				network: "trc20",
				amount_from: 500,
				payout_method: "office",
			},
			messages: [
				{
					role: "user",
					text: `Здравствуйте, хочу поменять 500 USDT TRC20 на ${QUOTE_WORD_PL}.`,
				},
				{
					role: "assistant",
					text: `Здравствуйте. Принял: 500 USDT в сети TRC20. Получение хотите наличными в офисе или переводом на ${currency.bankLabel}?`,
				},
			],
		},
		{
			// RUB-сценарий: показывает универсальный сбор способа ВНЕСЕНИЯ
			// (payment_method) — нового поля воронки.
			key: "rate-request-rub",
			stage: "exchange_request",
			name: "Ольга Сафина",
			telegramId: "demo_exchange_001b",
			fields: {
				asset_from: "rub",
				amount_from: 50000,
				payout_method: "atm",
				payment_method: "card_transfer",
			},
			messages: [
				{
					role: "user",
					text: `Хочу обменять 50000 рублей на ${QUOTE_WORD_PL}, внесу переводом со счёта, получу в банкомате.`,
				},
				{
					role: "assistant",
					text: "Принял: 50000 RUB, внесение банковским переводом, выдача через банкомат. Сейчас рассчитаю сумму.",
				},
			],
		},
		{
			key: "quote-confirmed",
			stage: "quote_calculated",
			name: "Мария Соколова",
			telegramId: "demo_exchange_002",
			fields: {
				exchange_rate: P.usdtRate,
				thb_amount: QUOTE_CONFIRMED_TO,
				rate_confirmed: true,
			},
			messages: [
				{ role: "user", text: "Сколько получу за 2000 USDT?" },
				{
					role: "assistant",
					text: `По текущей approved rate-card: 2000 USDT TRC20 -> ${fmtAmount(QUOTE_CONFIRMED_TO)} ${QUOTE}. Зафиксировать заявку?`,
				},
				{ role: "user", text: `Да, фиксируем. Получение в ${P.office1Label}.` },
			],
		},
		{
			key: "kyc-needed",
			stage: "kyc_collection",
			name: "Андрей Морозов",
			telegramId: "demo_exchange_003",
			operator: true,
			fields: {
				verification_video: "telegram:file_id/demo-kyc-video",
				customer_name_kyc: "Андрей Морозов",
			},
			messages: [
				{
					role: "user",
					text: `Нужно ${P.kycTargetQuote} ${currency.wordGen}, рублями с карты.`,
				},
				{
					role: "assistant",
					text: "Для этой суммы нужна быстрая KYC-проверка: документ и короткое видео с ФИО и направлением обмена.",
				},
				{
					role: "human",
					text: "Андрей, получил видео. Проверяю данные и после подтверждения выдам реквизиты.",
				},
			],
			order: {
				status: "awaiting_payment",
				direction: `RUB->${QUOTE}`,
				assetFrom: "RUB",
				network: "",
				amountFrom: KYC_FROM_RUB,
				rate: P.rubRate,
				amountToThb: P.kycTargetQuote,
				paymentMethod: "sbp_qr",
				paymentRail: "rub_sbp",
				payoutMethod: "thai_bank_transfer",
				requisitesJson: {
					type: "sbp",
					recipient: "LE Demo Ops",
					phone: "+7 999 488-00-00",
					bank: "T-Bank",
					ttlMinutes: 30,
				},
				riskJson: { decision: "manual", reason: "first_time_large_rub_deal" },
			},
		},
		{
			key: "requisites-sent",
			stage: "requisites_sent",
			name: "Елена Ким",
			telegramId: "demo_exchange_004",
			fields: {
				requisites_text:
					"USDT TRC20 wallet: TLEdemoUSDTTRC20Wallet1111111111111",
				requisites_ttl: 30,
			},
			messages: [
				{
					role: "user",
					text: `Подтверждаю 1000 USDT, выдача ${P.office2Label}.`,
				},
				{
					role: "assistant",
					text: "Заявка создана. Отправьте 1000 USDT TRC20 на кошелёк TLEdemoUSDTTRC20Wallet1111111111111. Реквизиты действуют 30 минут.",
				},
			],
			order: {
				status: "awaiting_payment",
				direction: `USDT->${QUOTE}`,
				assetFrom: "USDT",
				network: "trc20",
				amountFrom: 1000,
				rate: P.usdtRate,
				amountToThb: REQUISITES_TO,
				paymentMethod: "crypto_transfer",
				paymentRail: "trc20",
				payoutMethod: "office_cash",
				payoutLocation: P.office2Key,
				requisitesJson: {
					type: "wallet",
					asset: "USDT",
					network: "TRC20",
					address: "TLEdemoUSDTTRC20Wallet1111111111111",
					ttlMinutes: 30,
				},
				riskJson: { decision: "pass" },
			},
		},
		{
			key: "proof-waiting",
			stage: "payment_proof_waiting",
			name: "Олег Власов",
			telegramId: "demo_exchange_005",
			fields: {
				payment_proof_text: "0xdemo-trc20-proof-hash",
			},
			messages: [
				{ role: "user", text: "Отправил USDT, хэш 0xdemo-trc20-proof-hash." },
				{
					role: "assistant",
					text: `Спасибо, вижу хэш. Передал оплату на проверку, после подтверждения подготовим выдачу ${QUOTE}.`,
				},
			],
			order: {
				status: "paid",
				direction: `USDT->${QUOTE}`,
				assetFrom: "USDT",
				network: "trc20",
				amountFrom: 335,
				rate: P.usdtRate,
				amountToThb: PROOF_TO,
				paymentMethod: "crypto_transfer",
				paymentRail: "trc20",
				payoutMethod: "cardless_atm",
				proofJson: { txHash: "0xdemo-trc20-proof-hash", confirmations: 3 },
				riskJson: { decision: "pass" },
			},
		},
		{
			key: "completed",
			stage: "payout_or_completion",
			name: "Наталья Орлова",
			telegramId: "demo_exchange_006",
			fields: {
				final_thb_paid: P.completedQuote,
				payout_code_final: "LE-4881",
			},
			messages: [
				{ role: "user", text: "Чек отправила, деньги дошли?" },
				{
					role: "human",
					text: `Оплата подтверждена. Выдача ${fmtAmount(P.completedQuote)} ${QUOTE} готова в ${P.office1Label}, код LE-4881.`,
				},
				{ role: "user", text: "Получила, спасибо!" },
			],
			order: {
				status: "completed",
				direction: `RUB->${QUOTE}`,
				assetFrom: "RUB",
				network: "",
				amountFrom: COMPLETED_FROM_RUB,
				rate: P.rubRate,
				amountToThb: P.completedQuote,
				paymentMethod: "card_transfer",
				paymentRail: "rub_card",
				payoutMethod: "office_cash",
				payoutLocation: P.office1Key,
				payoutCode: "LE-4881",
				proofJson: {
					receipt: "telegram:file_id/demo-rub-receipt",
					checkedBy: "operator",
				},
				riskJson: { decision: "pass" },
			},
		},
		{
			key: "cancelled",
			stage: "cancelled",
			name: "Сергей Павлов",
			telegramId: "demo_exchange_007",
			fields: {
				cancel_reason: "rate",
			},
			messages: [
				{ role: "user", text: "Курс не подходит, отменяем." },
				{
					role: "assistant",
					text: "Понял, заявку отменяю. Если сумма или способ получения изменятся, пересчитаю свежую котировку.",
				},
			],
			order: {
				status: "cancelled",
				direction: `USDT->${QUOTE}`,
				assetFrom: "USDT",
				network: "trc20",
				amountFrom: 150,
				rate: P.usdtRateCancelled,
				amountToThb: CANCELLED_TO,
				paymentMethod: "crypto_transfer",
				paymentRail: "trc20",
				payoutMethod: "office_cash",
				riskJson: { decision: "cancelled_by_customer" },
			},
		},
	];
}

// Демо-лиды воронки «Трансфер» (стадии transfer_* — слоги уникальны между
// воронками, merged stage-контекст кладёт лид в нужную воронку). Цены PHP,
// филиппинский колорит: NAIA, Makati, BGC.
function buildTransferLeads(): DemoLead[] {
	return [
		{
			key: "transfer-request",
			stage: "transfer_request",
			name: "Дмитрий Соколов",
			telegramId: "demo_transfer_001",
			fields: {
				pickup: "NAIA Terminal 3",
				dropoff: "Fairmont Makati",
				date: "завтра",
				time: "рейс SQ916, прилёт 14:40",
				passengers: 2,
			},
			messages: [
				{
					role: "user",
					text: "Прилетаю завтра рейсом SQ916 в 14:40, NAIA Terminal 3. Нужен минивэн до Fairmont Makati, нас двое и два чемодана.",
				},
				{
					role: "assistant",
					text: "Принял: завтра, SQ916, NAIA T3 → Fairmont Makati, 2 пассажира с багажом, минивэн. Передаю оператору на подтверждение цены — отвечу в этом чате в течение нескольких минут.",
				},
			],
		},
		{
			key: "transfer-confirmed",
			stage: "transfer_offer",
			name: "Анна Ким",
			telegramId: "demo_transfer_002",
			fields: {
				price: 2800,
				vehicle: "седан",
				confirmed: true,
			},
			messages: [
				{
					role: "user",
					text: "Сколько будет седан NAIA Terminal 1 → Shangri-La The Fort (BGC)?",
				},
				{
					role: "assistant",
					text: "Седан NAIA T1 → Shangri-La The Fort — 2 800 PHP. Водитель встретит с табличкой в зоне прилёта, ожидание по рейсу бесплатно до 60 минут. Подтверждаем?",
				},
				{ role: "user", text: "Да, подтверждаю." },
			],
		},
		{
			key: "transfer-done",
			stage: "transfer_done",
			name: "Олег Тарасов",
			telegramId: "demo_transfer_003",
			fields: {},
			messages: [
				{
					role: "assistant",
					text: "Водитель назначен: Marco, белый Toyota Innova, табличка с вашим именем у выхода NAIA T3. Ночной тариф — 4 500 PHP, оплата наличными или GCash.",
				},
				{ role: "user", text: "Доехали, спасибо! Всё отлично." },
			],
		},
	];
}

// Демо-лиды воронки «Зелёный коридор» (VIP-встреча в аэропорту, стадии gc_*).
function buildGreenCorridorLeads(): DemoLead[] {
	return [
		{
			key: "gc-family-request",
			stage: "gc_confirm",
			name: "Семья Волковых",
			telegramId: "demo_gc_001",
			fields: {
				price: 12000,
				confirmed: false,
			},
			messages: [
				{
					role: "user",
					text: "Нужен зелёный коридор: прилетаем семьёй из 4 человек, рейс EK332, NAIA Terminal 1. Что входит и сколько стоит?",
				},
				{
					role: "assistant",
					text: "Встретим у выхода с рейса, проведём через паспортный контроль без очереди и поможем с багажом. Пакет Family на 4 человек — 12 000 PHP. Подтвердить бронь на рейс EK332?",
				},
			],
		},
		{
			key: "gc-done",
			stage: "gc_done",
			name: "Павел Орлов",
			telegramId: "demo_gc_002",
			fields: {},
			messages: [
				{
					role: "assistant",
					text: "Встречающий: Liza, место встречи — у выхода с телетрапа NAIA T3, табличка с вашим именем. Пакет Standard — 8 000 PHP.",
				},
				{
					role: "user",
					text: "Встретили у трапа, паспортный контроль прошли за 15 минут. Супер-сервис!",
				},
			],
		},
	];
}

function parseArgs(): Args {
	const out: Partial<Args> = {
		slug: process.env.EXCHANGE_DEMO_TENANT_SLUG ?? DEFAULT_SLUG,
		ownerEmail: process.env.EXCHANGE_DEMO_OWNER_EMAIL ?? DEFAULT_OWNER_EMAIL,
		operatorEmail:
			process.env.EXCHANGE_DEMO_OPERATOR_EMAIL ?? DEFAULT_OPERATOR_EMAIL,
		password: process.env.EXCHANGE_DEMO_PASSWORD ?? DEFAULT_PASSWORD,
		telegramBotToken: process.env.EXCHANGE_DEMO_TELEGRAM_BOT_TOKEN ?? null,
		telegramBotUsername:
			process.env.EXCHANGE_DEMO_TELEGRAM_BOT_USERNAME ?? null,
		llmProvider:
			process.env.EXCHANGE_DEMO_LLM_PROVIDER ??
			process.env.LLM_PROVIDER ??
			DEFAULT_LLM_PROVIDER,
		llmModel:
			process.env.EXCHANGE_DEMO_LLM_MODEL ??
			process.env.LLM_MODEL ??
			DEFAULT_LLM_MODEL,
		llmApiKey:
			process.env.EXCHANGE_DEMO_LLM_API_KEY ?? process.env.LLM_API_KEY ?? null,
		llmBaseUrl:
			process.env.EXCHANGE_DEMO_LLM_BASE_URL ??
			process.env.LLM_BASE_URL ??
			null,
		publicUrl: process.env.PLATFORM_PUBLIC_URL ?? null,
		setTelegramWebhook: false,
		quoteAsset: process.env.EXCHANGE_DEMO_QUOTE_ASSET ?? null,
		brand: process.env.EXCHANGE_DEMO_BRAND ?? "Lead Engine Exchange Demo",
	};

	for (const arg of process.argv.slice(2)) {
		if (arg === "--set-telegram-webhook") {
			out.setTelegramWebhook = true;
			continue;
		}
		const [rawKey, ...rest] = arg.replace(/^--/, "").split("=");
		const value = rest.join("=");
		if (!rawKey || value === undefined) continue;
		if (rawKey === "slug") out.slug = value;
		else if (rawKey === "owner-email") out.ownerEmail = value;
		else if (rawKey === "operator-email") out.operatorEmail = value;
		else if (rawKey === "password") out.password = value;
		else if (rawKey === "telegram-bot-token") out.telegramBotToken = value;
		else if (rawKey === "telegram-bot-username")
			out.telegramBotUsername = value;
		else if (rawKey === "llm-provider") out.llmProvider = value;
		else if (rawKey === "llm-model") out.llmModel = value;
		else if (rawKey === "llm-api-key") out.llmApiKey = value;
		else if (rawKey === "llm-base-url") out.llmBaseUrl = value;
		else if (rawKey === "public-url") out.publicUrl = value;
		else if (rawKey === "quote-asset") out.quoteAsset = value;
		else if (rawKey === "brand") out.brand = value;
	}

	const llmProvider = normalizeLlmProvider(
		out.llmProvider ?? DEFAULT_LLM_PROVIDER,
	);
	const llmModel = String(out.llmModel ?? DEFAULT_LLM_MODEL).trim();
	if (!llmModel) throw new Error("LLM model cannot be empty");

	return {
		slug: out.slug ?? DEFAULT_SLUG,
		ownerEmail: out.ownerEmail ?? DEFAULT_OWNER_EMAIL,
		operatorEmail: out.operatorEmail ?? DEFAULT_OPERATOR_EMAIL,
		password: out.password ?? DEFAULT_PASSWORD,
		telegramBotToken: out.telegramBotToken ?? null,
		telegramBotUsername: normalizeTelegramUsername(
			out.telegramBotUsername ?? null,
		),
		llmProvider,
		llmModel,
		llmApiKey: normalizeOptional(out.llmApiKey ?? null),
		llmBaseUrl: normalizePublicUrl(out.llmBaseUrl ?? null),
		publicUrl: normalizePublicUrl(out.publicUrl ?? null),
		setTelegramWebhook: out.setTelegramWebhook ?? false,
		quoteAsset: normalizeOptional(out.quoteAsset ?? null),
		brand: out.brand?.trim() || "Lead Engine Exchange Demo",
	};
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`env ${name} required`);
	return value;
}

function normalizeTelegramUsername(value: string | null): string | null {
	const trimmed = value?.trim().replace(/^@/, "") ?? "";
	return trimmed ? trimmed : null;
}

function normalizeLlmProvider(value: string): LlmProvider {
	const provider = value.trim().toLowerCase();
	if (
		provider === "openai" ||
		provider === "openrouter" ||
		provider === "ollama" ||
		provider === "anthropic"
	) {
		return provider;
	}
	throw new Error(
		"LLM provider must be one of: openai, openrouter, ollama, anthropic",
	);
}

function normalizeOptional(value: string | null): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed ? trimmed : null;
}

function normalizePublicUrl(value: string | null): string | null {
	const trimmed = value?.trim().replace(/\/+$/, "") ?? "";
	return trimmed ? trimmed : null;
}

function stableHash(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function roughTokenCount(input: string): number {
	return input.split(/\s+/).filter(Boolean).length;
}

async function upsertTenant(db: Db, args: Args, now: number): Promise<number> {
	const [existing] = await db
		.select({ id: tenants.id })
		.from(tenants)
		.where(eq(tenants.slug, args.slug))
		.limit(1);
	if (existing) {
		await db
			.update(tenants)
			.set({
				plan: "free",
				status: "active",
				llmBillingMode: "byok",
				updatedAt: now,
			})
			.where(eq(tenants.id, existing.id));
		return existing.id;
	}
	const [tenant] = await db
		.insert(tenants)
		.values({
			slug: args.slug,
			plan: "free",
			status: "active",
			llmBillingMode: "byok",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: tenants.id });
	if (!tenant) throw new Error("tenant insert returned no row");
	return tenant.id;
}

async function upsertAdmin(input: {
	db: Db;
	tenantId: number;
	email: string;
	name: string;
	role: Role;
	password: string;
	now: number;
}): Promise<number> {
	const passwordHash = await hashPassword(input.password);
	return withTenant(input.db, input.tenantId, async (tx) => {
		const [existing] = await tx
			.select({ id: admins.id })
			.from(admins)
			.where(eq(admins.email, input.email))
			.limit(1);
		if (existing) {
			await tx
				.update(admins)
				.set({
					email: input.email,
					name: input.name,
					role: input.role,
					passwordHash,
				})
				.where(eq(admins.id, existing.id));
			return existing.id;
		}
		const [admin] = await tx
			.insert(admins)
			.values({
				tenantId: input.tenantId,
				email: input.email,
				name: input.name,
				role: input.role,
				passwordHash,
				createdAt: input.now,
			})
			.returning({ id: admins.id });
		if (!admin) throw new Error(`admin insert failed: ${input.email}`);
		return admin.id;
	});
}

async function seedChannelsAndLlm(input: {
	db: Db;
	tenantId: number;
	args: Args;
	masterKeyHex: string;
	now: number;
}): Promise<{
	webChannelId: number;
	telegramChannelId: number | null;
	telegramUsername: string | null;
	llmHasSecret: boolean;
}> {
	return withTenant(input.db, input.tenantId, async (tx) => {
		const [web] = await tx
			.insert(channels)
			.values({
				tenantId: input.tenantId,
				kind: "web",
				externalId: input.args.slug,
				status: "active",
				metadataJson: JSON.stringify({
					demoSeed: DEMO_SEED,
					brandName: input.args.brand,
				}),
				createdAt: input.now,
				updatedAt: input.now,
			})
			.onConflictDoUpdate({
				target: [channels.tenantId, channels.kind, channels.externalId],
				set: {
					status: "active",
					metadataJson: JSON.stringify({
						demoSeed: DEMO_SEED,
						brandName: input.args.brand,
					}),
					updatedAt: input.now,
				},
			})
			.returning({ id: channels.id });
		if (!web) throw new Error("web channel upsert failed");

		let telegramChannelId: number | null = null;
		let telegramUsername: string | null = null;
		if (input.args.telegramBotToken) {
			telegramUsername =
				input.args.telegramBotUsername ??
				`${input.args.slug.replace(/-/g, "_")}_bot`;
			const secretKey = `channel_telegram_bot_${telegramUsername}`;
			await setEncryptedSecret({
				db: tx as Db,
				tenantId: input.tenantId,
				key: secretKey,
				value: input.args.telegramBotToken,
				masterKeyHex: input.masterKeyHex,
				nowEpoch: input.now,
			});
			const [telegram] = await tx
				.insert(channels)
				.values({
					tenantId: input.tenantId,
					kind: "telegram_bot",
					externalId: telegramUsername,
					credentialsRef: secretKey,
					status: "active",
					metadataJson: JSON.stringify({
						username: telegramUsername,
						demoSeed: DEMO_SEED,
						webhookPath: `/webhook/telegram/${input.args.slug}`,
					}),
					createdAt: input.now,
					updatedAt: input.now,
				})
				.onConflictDoUpdate({
					target: [channels.tenantId, channels.kind, channels.externalId],
					set: {
						credentialsRef: secretKey,
						status: "active",
						metadataJson: JSON.stringify({
							username: telegramUsername,
							demoSeed: DEMO_SEED,
							webhookPath: `/webhook/telegram/${input.args.slug}`,
						}),
						updatedAt: input.now,
					},
				})
				.returning({ id: channels.id });
			if (!telegram) throw new Error("telegram channel upsert failed");
			telegramChannelId = telegram.id;
		}

		const [existingChatLlm] = await tx
			.select({ secretRef: llmProviderConfigs.secretRef })
			.from(llmProviderConfigs)
			.where(
				and(
					eq(llmProviderConfigs.tenantId, input.tenantId),
					eq(llmProviderConfigs.purpose, "chat"),
				),
			)
			.limit(1);
		let chatSecretRef = existingChatLlm?.secretRef ?? null;
		if (input.args.llmApiKey) {
			chatSecretRef = "llm_chat_apikey";
			await setEncryptedSecret({
				db: tx as Db,
				tenantId: input.tenantId,
				key: chatSecretRef,
				value: input.args.llmApiKey,
				masterKeyHex: input.masterKeyHex,
				nowEpoch: input.now,
			});
		}

		await tx
			.insert(llmProviderConfigs)
			.values({
				tenantId: input.tenantId,
				purpose: "chat",
				provider: input.args.llmProvider,
				model: input.args.llmModel,
				secretRef: chatSecretRef,
				baseUrl: input.args.llmBaseUrl,
				createdAt: input.now,
				updatedAt: input.now,
			})
			.onConflictDoUpdate({
				target: [llmProviderConfigs.tenantId, llmProviderConfigs.purpose],
				set: {
					provider: input.args.llmProvider,
					model: input.args.llmModel,
					secretRef: chatSecretRef,
					baseUrl: input.args.llmBaseUrl,
					updatedAt: input.now,
				},
			});

		return {
			webChannelId: web.id,
			telegramChannelId,
			telegramUsername,
			llmHasSecret:
				input.args.llmProvider === "ollama" || chatSecretRef != null,
		};
	});
}

// Три воронки демо-тенанта. Exchange сидится ПЕРВЫМ: наименьший funnel id =
// корректный fallback интент-роутера (первая активная воронка) и primary-funnel
// в дашборде. У transfer/green_corridor vertical_template_id нет — их персона
// задаётся goal/guidance стадий + KB; exchange_v1 остаётся шаблоном тенанта.
const DEMO_FUNNELS: Array<{ key: string; verticalTemplateId: string | null }> =
	[
		{ key: "exchange", verticalTemplateId: "exchange_v1" },
		{ key: "transfer", verticalTemplateId: null },
		{ key: "green_corridor", verticalTemplateId: null },
	];

async function seedDemoFunnels(input: {
	db: Db;
	tenantId: number;
	ownerAdminId: number;
	now: number;
}): Promise<Map<string, { funnelId: number; stagesCreated: number }>> {
	const byKey = new Map<string, { funnelId: number; stagesCreated: number }>();
	for (const item of DEMO_FUNNELS) {
		const seeded = await seedFunnelByKey(
			input.db,
			input.tenantId,
			item.key,
			input.ownerAdminId,
		);
		if ("error" in seeded)
			throw new Error(`seedFunnel(${item.key}): ${seeded.error}`);
		await withTenant(input.db, input.tenantId, async (tx) => {
			await tx
				.update(funnels)
				.set({
					verticalTemplateId: item.verticalTemplateId,
					isActive: true,
					updatedAt: input.now,
				})
				.where(
					and(
						eq(funnels.tenantId, input.tenantId),
						eq(funnels.id, seeded.funnelId),
					),
				);
		});
		byKey.set(item.key, seeded);
	}
	return byKey;
}

// Каталог услуг: явный маршрут «текст клиента → воронка». Дополняет интент-
// роутер (каталог матчится первым) и даёт аудит маршрута в lead-notes.
// Токены дизъюнктны: «аэропорт» только у трансфера, коридор — по своим словам.
async function seedServiceCatalog(input: {
	db: Db;
	tenantId: number;
	funnelIdByKey: Map<string, { funnelId: number }>;
	now: number;
}): Promise<number> {
	const items = [
		{
			slug: "exchange",
			name: "Обмен валют",
			category: "exchange",
			description: "обмен, курс, USDT, крипта, рубли, песо, наличные",
			funnelKey: "exchange",
			sortOrder: 0,
		},
		{
			slug: "transfer",
			name: "Трансфер из аэропорта",
			category: "transfer",
			description:
				"трансфер, аэропорт, NAIA, встретить, довезти, минивэн, такси",
			funnelKey: "transfer",
			sortOrder: 1,
		},
		{
			slug: "green_corridor",
			name: "Зелёный коридор",
			category: "vip",
			description:
				"зелёный коридор, зеленый коридор, fast track, vip встреча, сопровождение, паспортный контроль",
			funnelKey: "green_corridor",
			sortOrder: 2,
		},
	];
	await withTenant(input.db, input.tenantId, async (tx) => {
		for (const item of items) {
			const funnelId = input.funnelIdByKey.get(item.funnelKey)?.funnelId;
			if (!funnelId)
				throw new Error(`catalog: no funnel for ${item.funnelKey}`);
			await tx
				.insert(serviceCatalogItems)
				.values({
					tenantId: input.tenantId,
					slug: item.slug,
					name: item.name,
					category: item.category,
					description: item.description,
					routeType: "funnel",
					funnelId,
					isActive: true,
					sortOrder: item.sortOrder,
					metadataJson: JSON.stringify({ demoSeed: DEMO_SEED }),
					createdAt: input.now,
					updatedAt: input.now,
				})
				.onConflictDoUpdate({
					target: [serviceCatalogItems.tenantId, serviceCatalogItems.slug],
					set: {
						name: item.name,
						category: item.category,
						description: item.description,
						routeType: "funnel",
						funnelId,
						isActive: true,
						sortOrder: item.sortOrder,
						updatedAt: input.now,
					},
				});
		}
	});
	return items.length;
}

// Director hooks: пер-тенантные инструкции в каждый промпт (данные, не код).
// (а) кросс-сейл трансфера/коридора по дате прилёта; (б) мульти-сервисная
// идентичность + поведение на «вопрос про курс».
async function seedDirectorHooks(input: {
	db: Db;
	tenantId: number;
	now: number;
}): Promise<number> {
	const hooks = [
		{
			name: "Кросс-сейл по прилёту",
			body: "Если клиент упоминает дату прилёта, номер рейса или что он скоро прилетает — после ответа на его вопрос предложи ОДНОЙ фразой трансфер из аэропорта и VIP-встречу «зелёный коридор» (встреча у выхода, проход без очередей). Не настаивай и не повторяй предложение в каждом сообщении.",
			triggerHint: "прилёт, рейс, дата прилёта",
			position: 0,
		},
		{
			name: "Три сервиса в одном боте",
			body: "Компания делает не только обмен валют: также аэропорт-трансфер и VIP-встречу в аэропорту («зелёный коридор»). Если клиент спрашивает про трансфер или встречу — собери заявку, не отправляй его «в другую компанию». Если клиент просто спрашивает курс — назови курс строго через инструмент compute_exchange_quote и мягко предложи оформить обмен, без давления.",
			triggerHint: "трансфер, зелёный коридор, курс",
			position: 1,
		},
	];
	await withTenant(input.db, input.tenantId, async (tx) => {
		for (const hook of hooks) {
			await tx
				.delete(directorHooks)
				.where(
					and(
						eq(directorHooks.tenantId, input.tenantId),
						eq(directorHooks.name, hook.name),
					),
				);
			await tx.insert(directorHooks).values({
				tenantId: input.tenantId,
				name: hook.name,
				body: hook.body,
				triggerHint: hook.triggerHint,
				isActive: true,
				position: hook.position,
				createdAt: input.now,
				updatedAt: input.now,
			});
		}
	});
	return hooks.length;
}

// Sales-стиль обмена. БЕЗ активного стиля resolveStyle тенанта = null → бот
// падает на legacy buildSystemPrompt (рекрутинговый), минуя sales-путь
// composeSystemPrompt (stage-grounding, hooks, few-shot). Сеем fastTraderPas
// активным. Slug скоупим тенантом: uniq_styles_active_slug и uniq_styles_slug_version
// глобальны (по slug), иначе второй тенант с тем же стилем падал бы на конфликте.
// default_style_id воронки тоже проставляем (forward-compat; роутинг идёт по
// активной styles-строке тенанта). Идемпотентно: upsert по (tenantId, slug) среди
// живых (deleted_at IS NULL).
async function seedSalesStyle(input: {
	db: Db;
	tenantId: number;
	exchangeFunnelId: number;
	now: number;
}): Promise<{ styleId: number; slug: string }> {
	const slug = `${fastTraderPas.slug}-${input.tenantId}`;
	const configJson = JSON.stringify(fastTraderPas);
	return withTenant(input.db, input.tenantId, async (tx) => {
		const [existing] = await tx
			.select({ id: styles.id })
			.from(styles)
			.where(
				and(
					eq(styles.tenantId, input.tenantId),
					eq(styles.slug, slug),
					isNull(styles.deletedAt),
				),
			)
			.limit(1);
		let styleId: number;
		if (existing) {
			await tx
				.update(styles)
				.set({
					displayName: fastTraderPas.displayName,
					configJson,
					isActive: true,
				})
				.where(eq(styles.id, existing.id));
			styleId = existing.id;
		} else {
			const [inserted] = await tx
				.insert(styles)
				.values({
					tenantId: input.tenantId,
					slug,
					displayName: fastTraderPas.displayName,
					configJson,
					isActive: true,
					version: 1,
					createdAt: input.now,
				})
				.returning({ id: styles.id });
			if (!inserted) throw new Error("style insert failed");
			styleId = inserted.id;
		}
		await tx
			.update(funnels)
			.set({ defaultStyleId: styleId, updatedAt: input.now })
			.where(
				and(
					eq(funnels.tenantId, input.tenantId),
					eq(funnels.id, input.exchangeFunnelId),
				),
			);
		return { styleId, slug };
	});
}

// KB-сэмплы трёх сервисов: каждый dir сидится глобально-скоупленными доками
// (бот видит их во всех воронках; маршрут по воронкам решает интент-роутер).
const KB_SAMPLE_SETS: Array<{ dir: string; topic: string; files: string[] }> = [
	{ dir: "exchange", topic: "exchange", files: ["faq.md", "how-to-pay.md"] },
	{
		dir: "transfer",
		topic: "transfer",
		files: ["pricing-zones.md", "rules.md"],
	},
	{ dir: "green_corridor", topic: "green_corridor", files: ["service.md"] },
];

async function seedSampleKb(input: {
	db: Db;
	tenantId: number;
	now: number;
}): Promise<number> {
	let count = 0;
	await withTenant(input.db, input.tenantId, async (tx) => {
		for (const set of KB_SAMPLE_SETS) {
			const dir = resolve(__dirname, "..", "kb-samples", set.dir);
			for (const file of set.files) {
				const path = resolve(dir, file);
				if (!existsSync(path)) throw new Error(`KB sample missing: ${path}`);
				const text = readFileSync(path, "utf8");
				const source = `kb-samples/${set.dir}/${basename(file)}`;
				await tx
					.delete(kbDocuments)
					.where(
						and(
							eq(kbDocuments.tenantId, input.tenantId),
							eq(kbDocuments.source, source),
						),
					);
				const [doc] = await tx
					.insert(kbDocuments)
					.values({
						tenantId: input.tenantId,
						source,
						title: `${set.topic} sample: ${basename(file, ".md")}`,
						contentHash: stableHash(text),
						topic: set.topic,
						scopeType: "global",
						fileName: file,
						fileMimeType: "text/markdown",
						fileSizeBytes: Buffer.byteLength(text, "utf8"),
						fileUploadedAt: input.now,
						createdAt: input.now,
					})
					.returning({ id: kbDocuments.id });
				if (!doc) throw new Error(`failed to seed KB sample ${file}`);
				await tx.insert(kbChunks).values({
					tenantId: input.tenantId,
					documentId: doc.id,
					chunkIndex: 0,
					text,
					tokenCount: roughTokenCount(text),
					embedding: null,
					createdAt: input.now,
				});
				count++;
			}
		}
	});
	return count;
}

async function cleanDemoRows(input: {
	db: Db;
	tenantId: number;
	slug: string;
}): Promise<void> {
	await withTenant(input.db, input.tenantId, async (tx) => {
		await tx
			.delete(exchangeOrders)
			.where(
				and(
					eq(exchangeOrders.tenantId, input.tenantId),
					like(exchangeOrders.idempotencyKey, `${DEMO_SEED}:${input.slug}:%`),
				),
			);
		const demoContacts = await tx
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				and(
					eq(contacts.tenantId, input.tenantId),
					like(contacts.attributesJson, `%"demoSeed":"${DEMO_SEED}"%`),
				),
			);
		const contactIds = demoContacts.map((row) => row.id);
		if (contactIds.length > 0) {
			await tx.delete(contacts).where(inArray(contacts.id, contactIds));
		}
	});
}

// Слоги стадий всех демо-воронок (exchange_*, transfer_*, gc_*) не пересекаются,
// поэтому stage-контекст можно безопасно слить в одну карту slug→id.
async function loadStageContext(input: {
	db: Db;
	tenantId: number;
	funnelIds: number[];
}) {
	return withTenant(input.db, input.tenantId, async (tx) => {
		const stageRows = await tx
			.select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
			.from(stageDefinitions)
			.where(inArray(stageDefinitions.funnelId, input.funnelIds));
		const fieldRows = await tx
			.select({
				id: stageFields.id,
				slug: stageFields.slug,
				stageSlug: stageDefinitions.slug,
			})
			.from(stageFields)
			.innerJoin(stageDefinitions, eq(stageDefinitions.id, stageFields.stageId))
			.where(inArray(stageDefinitions.funnelId, input.funnelIds));

		const stageIdBySlug = new Map(
			stageRows.map((stage) => [stage.slug, stage.id]),
		);
		const fieldIdByStage = new Map<string, Map<string, number>>();
		for (const field of fieldRows) {
			const fields =
				fieldIdByStage.get(field.stageSlug) ?? new Map<string, number>();
			fields.set(field.slug, field.id);
			fieldIdByStage.set(field.stageSlug, fields);
		}
		return { stageIdBySlug, fieldIdByStage };
	});
}

async function seedDemoWorkflow(input: {
	db: Db;
	tenantId: number;
	slug: string;
	channelId: number;
	operatorAdminId: number;
	funnelIds: number[];
	now: number;
	sampleLeads: DemoLead[];
}): Promise<{ leads: number; messages: number; orders: number }> {
	const SAMPLE_LEADS = input.sampleLeads;
	await cleanDemoRows({
		db: input.db,
		tenantId: input.tenantId,
		slug: input.slug,
	});
	const { stageIdBySlug, fieldIdByStage } = await loadStageContext({
		db: input.db,
		tenantId: input.tenantId,
		funnelIds: input.funnelIds,
	});

	let leadCount = 0;
	let messageCount = 0;
	let orderCount = 0;

	await withTenant(input.db, input.tenantId, async (tx) => {
		for (let i = 0; i < SAMPLE_LEADS.length; i++) {
			const sample = SAMPLE_LEADS[i];
			if (!sample) continue;
			const stageId = stageIdBySlug.get(sample.stage);
			if (!stageId)
				throw new Error(`exchange stage not found: ${sample.stage}`);
			const createdAt = input.now - (SAMPLE_LEADS.length - i) * 3600;

			const [contact] = await tx
				.insert(contacts)
				.values({
					tenantId: input.tenantId,
					displayName: sample.name,
					attributesJson: JSON.stringify({
						demoSeed: DEMO_SEED,
						exchangeDemoKey: sample.key,
						exchangeKyc:
							sample.stage === "kyc_collection"
								? { status: "pending" }
								: { status: "verified", verificationId: `demo-kyc-${i + 1}` },
					}),
					createdAt,
					updatedAt: createdAt,
				})
				.returning({ id: contacts.id });
			if (!contact) throw new Error(`contact insert failed: ${sample.name}`);

			await tx.insert(channelIdentities).values({
				contactId: contact.id,
				channelId: input.channelId,
				externalUserId: sample.telegramId,
				createdAt,
			});

			const [lead] = await tx
				.insert(leads)
				.values({
					tenantId: input.tenantId,
					userId: contact.id,
					state: sample.stage,
					stageDefinitionId: stageId,
					intakeJson: JSON.stringify({
						demoSeed: DEMO_SEED,
						direction: sample.order?.direction ?? null,
					}),
					createdAt,
					updatedAt: createdAt,
				})
				.returning({ id: leads.id });
			if (!lead) throw new Error(`lead insert failed: ${sample.name}`);
			leadCount++;

			const fields = fieldIdByStage.get(sample.stage);
			if (fields) {
				for (const [fieldSlug, value] of Object.entries(sample.fields)) {
					const fieldId = fields.get(fieldSlug);
					if (!fieldId) continue;
					await tx.insert(leadFieldValues).values({
						leadId: lead.id,
						fieldId,
						tenantId: input.tenantId,
						valueJson: JSON.stringify(value),
						updatedAt: createdAt,
					});
				}
			}

			const lastMessage = sample.messages.at(-1);
			const lastAt = createdAt + (sample.messages.length - 1) * 120;
			const [conversation] = await tx
				.insert(conversations)
				.values({
					tenantId: input.tenantId,
					userId: contact.id,
					channelId: input.channelId,
					source: "bot",
					mode: sample.operator ? "human" : "ai",
					status: ["payout_or_completion", "transfer_done", "gc_done"].includes(
						sample.stage,
					)
						? "resolved"
						: "open",
					unreadCount: lastMessage?.role === "user" ? 1 : 0,
					lastMessageText: lastMessage?.text ?? null,
					lastMessageAt: lastAt,
					currentStage: sample.stage,
					assignedAdminId: sample.operator ? input.operatorAdminId : null,
					escalatedAt: sample.operator ? createdAt + 60 : null,
					metaJson: JSON.stringify({
						demoSeed: DEMO_SEED,
						exchangeDemoKey: sample.key,
					}),
					createdAt,
				})
				.returning({ id: conversations.id });
			if (!conversation)
				throw new Error(`conversation insert failed: ${sample.name}`);

			for (let j = 0; j < sample.messages.length; j++) {
				const message = sample.messages[j];
				if (!message) continue;
				await tx.insert(messages).values({
					tenantId: input.tenantId,
					conversationId: conversation.id,
					role: message.role,
					text: message.text,
					stage: sample.stage,
					metaJson: JSON.stringify({ demoSeed: DEMO_SEED }),
					createdAt: createdAt + j * 120,
				});
				messageCount++;
			}

			if (sample.order) {
				const rateExpiresAt =
					sample.order.status === "completed" ||
					sample.order.status === "cancelled"
						? null
						: input.now + 30 * 60;
				await tx.insert(exchangeOrders).values({
					tenantId: input.tenantId,
					contactId: contact.id,
					conversationId: conversation.id,
					leadId: lead.id,
					telegramId: sample.telegramId,
					direction: sample.order.direction,
					assetFrom: sample.order.assetFrom,
					network: sample.order.network,
					amountMode: "source_amount",
					requestedAmount: sample.order.amountFrom,
					amountFrom: sample.order.amountFrom,
					rate: sample.order.rate,
					amountToThb: sample.order.amountToThb,
					paymentMethod: sample.order.paymentMethod,
					paymentRail: sample.order.paymentRail,
					payoutMethod: sample.order.payoutMethod,
					payoutLocation: sample.order.payoutLocation ?? null,
					payoutCode: sample.order.payoutCode ?? null,
					payoutCodeExpiresAt: sample.order.payoutCode
						? input.now + 3600
						: null,
					status: sample.order.status,
					requisitesJson: sample.order.requisitesJson
						? JSON.stringify(sample.order.requisitesJson)
						: null,
					proofJson: sample.order.proofJson
						? JSON.stringify(sample.order.proofJson)
						: null,
					riskJson: sample.order.riskJson
						? JSON.stringify(sample.order.riskJson)
						: null,
					rateExpiresAt,
					idempotencyKey: `${DEMO_SEED}:${input.slug}:${sample.key}`,
					completedAt:
						sample.order.status === "completed" ? input.now - 900 : null,
					createdAt,
					updatedAt: input.now,
				});
				orderCount++;
			}
		}
	});

	return { leads: leadCount, messages: messageCount, orders: orderCount };
}

async function setTelegramWebhook(args: Args): Promise<boolean> {
	if (!args.telegramBotToken || !args.publicUrl || !args.setTelegramWebhook)
		return false;
	const webhookSecret = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
	const url = `${args.publicUrl}/webhook/telegram/${args.slug}`;
	const form = new URLSearchParams({
		url,
		secret_token: webhookSecret,
		drop_pending_updates: "true",
	});
	const response = await fetch(
		`https://api.telegram.org/bot${args.telegramBotToken}/setWebhook`,
		{
			method: "POST",
			body: form,
		},
	);
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Telegram setWebhook failed ${response.status}: ${body.slice(0, 300)}`,
		);
	}
	const body = (await response.json()) as {
		ok?: boolean;
		description?: string;
	};
	if (!body.ok)
		throw new Error(
			`Telegram setWebhook rejected: ${body.description ?? "unknown"}`,
		);
	return true;
}

async function readinessCounts(input: { db: Db; tenantId: number }) {
	return withTenant(input.db, input.tenantId, async (tx) => {
		const rates = await tx
			.select({ id: exchangeRates.id })
			.from(exchangeRates)
			.where(
				and(
					eq(exchangeRates.tenantId, input.tenantId),
					eq(exchangeRates.isActive, true),
				),
			);
		const tiers = await tx
			.select({ id: exchangeRateTiers.id })
			.from(exchangeRateTiers)
			.where(
				and(
					eq(exchangeRateTiers.tenantId, input.tenantId),
					eq(exchangeRateTiers.isActive, true),
				),
			);
		const sampleKb = await tx
			.select({ id: kbDocuments.id })
			.from(kbDocuments)
			.where(
				and(
					eq(kbDocuments.tenantId, input.tenantId),
					like(kbDocuments.source, "kb-samples/exchange/%"),
				),
			);
		const fixtureKb = await tx
			.select({ id: kbDocuments.id })
			.from(kbDocuments)
			.where(
				and(
					eq(kbDocuments.tenantId, input.tenantId),
					like(kbDocuments.source, "exchange-fixtures:%"),
				),
			);
		const channelRows = await tx
			.select({ id: channels.id })
			.from(channels)
			.where(
				and(
					eq(channels.tenantId, input.tenantId),
					eq(channels.status, "active"),
				),
			);
		const leadRows = await tx
			.select({ id: leads.id })
			.from(leads)
			.where(eq(leads.tenantId, input.tenantId));
		const orderRows = await tx
			.select({ id: exchangeOrders.id })
			.from(exchangeOrders)
			.where(eq(exchangeOrders.tenantId, input.tenantId));
		return {
			activeRates: rates.length,
			approvedTiers: tiers.length,
			sampleKbDocs: sampleKb.length,
			fixtureKbDocs: fixtureKb.length,
			activeChannels: channelRows.length,
			leads: leadRows.length,
			orders: orderRows.length,
		};
	});
}

async function main() {
	const args = parseArgs();
	const databaseUrl = requiredEnv("DATABASE_URL");
	const masterKeyHex = requiredEnv("PLATFORM_MASTER_KEY");
	if (masterKeyHex === MASTER_KEY_PLACEHOLDER) {
		throw new Error(
			"PLATFORM_MASTER_KEY must be the real 64-hex key, not the placeholder",
		);
	}

	const client = postgres(databaseUrl, { max: 2, prepare: false });
	const db = drizzle(client, { schema }) as Db;
	const now = Math.floor(Date.now() / 1000);

	try {
		const tenantId = await upsertTenant(db, args, now);
		const ownerAdminId = await upsertAdmin({
			db,
			tenantId,
			email: args.ownerEmail,
			name: "Демо Владелец",
			role: "superadmin",
			password: args.password,
			now,
		});
		const operatorAdminId = await upsertAdmin({
			db,
			tenantId,
			email: args.operatorEmail,
			name: "Оператор Обменки",
			role: "manager",
			password: args.password,
			now,
		});

		const channelResult = await seedChannelsAndLlm({
			db,
			tenantId,
			args,
			masterKeyHex,
			now,
		});
		const funnelsByKey = await seedDemoFunnels({
			db,
			tenantId,
			ownerAdminId,
			now,
		});
		const exchangeFunnel = funnelsByKey.get("exchange");
		if (!exchangeFunnel) throw new Error("exchange funnel missing after seed");
		const catalogItems = await seedServiceCatalog({
			db,
			tenantId,
			funnelIdByKey: funnelsByKey,
			now,
		});
		const directorHookCount = await seedDirectorHooks({ db, tenantId, now });
		const salesStyle = await seedSalesStyle({
			db,
			tenantId,
			exchangeFunnelId: exchangeFunnel.funnelId,
			now,
		});
		const currency = resolveQuoteCurrency(args.quoteAsset);
		const fixtureResult = await seedExchangeFixtures({
			db,
			tenantId,
			masterKeyHex,
			quoteAsset: currency.code,
		});
		const liveRates = await freshenSeededRates({ db, tenantId, currency, now });
		const sampleKbDocs = await seedSampleKb({ db, tenantId, now });
		const workflowResult = await seedDemoWorkflow({
			db,
			tenantId,
			slug: args.slug,
			channelId: channelResult.telegramChannelId ?? channelResult.webChannelId,
			operatorAdminId,
			funnelIds: [...funnelsByKey.values()].map((f) => f.funnelId),
			now,
			sampleLeads: [
				...buildSampleLeads(currency, liveRates),
				...buildTransferLeads(),
				...buildGreenCorridorLeads(),
			],
		});
		const webhookSet = await setTelegramWebhook(args);
		const counts = await readinessCounts({ db, tenantId });

		console.log("[seed-exchange-demo] done");
		console.log(
			JSON.stringify(
				{
					tenant: { id: tenantId, slug: args.slug, status: "active" },
					admins: {
						owner: args.ownerEmail,
						operator: args.operatorEmail,
						credentialNote:
							"password is set from EXCHANGE_DEMO_PASSWORD or the script default; not printed",
					},
					llm: {
						provider: args.llmProvider,
						model: args.llmModel,
						baseUrl: args.llmBaseUrl,
						hasSecret: channelResult.llmHasSecret,
					},
					channels: {
						webChannelId: channelResult.webChannelId,
						telegramChannelId: channelResult.telegramChannelId,
						telegramUsername: channelResult.telegramUsername,
						telegramWebhookSet: webhookSet,
					},
					funnels: Object.fromEntries(
						[...funnelsByKey.entries()].map(([key, value]) => [
							key,
							{
								id: value.funnelId,
								stagesCreated: value.stagesCreated,
								verticalTemplateId:
									DEMO_FUNNELS.find((f) => f.key === key)?.verticalTemplateId ??
									null,
							},
						]),
					),
					serviceCatalogItems: catalogItems,
					directorHooks: directorHookCount,
					salesStyle: { id: salesStyle.styleId, slug: salesStyle.slug },
					fixtures: fixtureResult,
					quote: {
						asset: currency.code,
						liveRates:
							liveRates ?? "feed unavailable — static fallback rates used",
					},
					sampleKbDocs,
					demoWorkflow: workflowResult,
					readiness: counts,
				},
				null,
				2,
			),
		);

		console.log("\n[seed-exchange-demo] next checks");
		console.log(
			`  - Admin UI login: ${args.ownerEmail} (use EXCHANGE_DEMO_PASSWORD or the documented default)`,
		);
		console.log(`  - Web channel: /ws/${args.slug}?user=<demo-user>`);
		if (args.telegramBotToken) {
			const publicUrl = args.publicUrl ?? "<PLATFORM_PUBLIC_URL>";
			console.log(
				`  - Telegram webhook: ${publicUrl}/webhook/telegram/${args.slug}` +
					(webhookSet ? " (set)" : " (not set by this run)"),
			);
			if (!webhookSet) {
				console.log(
					"  - To set webhook: rerun with --set-telegram-webhook and TELEGRAM_WEBHOOK_SECRET",
				);
			}
		} else {
			console.log(
				"  - Telegram channel skipped: set EXCHANGE_DEMO_TELEGRAM_BOT_TOKEN for live bot demo",
			);
		}
		console.log(
			"  - Diagnostics: GET /api/admin/diagnostics as the owner admin",
		);
	} finally {
		await client.end({ timeout: 0 }).catch(() => {});
	}
}

main().catch((err) => {
	console.error(
		"[seed-exchange-demo] FAILED:",
		err instanceof Error ? err.message : err,
	);
	process.exit(1);
});
