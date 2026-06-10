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
	setEncryptedSecret,
	withTenant,
} from "@chatman-media/conversation-engine";
import {
	admins,
	channelIdentities,
	channels,
	contacts,
	conversations,
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
	stageDefinitions,
	stageFields,
	tenants,
} from "@chatman-media/storage";
import { and, eq, inArray, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { hashPassword } from "../src/lib/auth.ts";
import { seedExchangeFixtures } from "../src/lib/exchange/fixtures.ts";
import { seedFunnelByKey } from "../src/routes/admin-funnel.ts";

const DEFAULT_SLUG = "exchange-demo";
const DEFAULT_OWNER_EMAIL = "owner@exchange.demo";
const DEFAULT_OPERATOR_EMAIL = "operator@exchange.demo";
const DEFAULT_PASSWORD = "test1234";
const DEMO_SEED = "exchange-demo";
const MASTER_KEY_PLACEHOLDER = "<64hex>";

type Role = "superadmin" | "manager";
type MessageRole = "user" | "assistant" | "human";

interface Args {
	slug: string;
	ownerEmail: string;
	operatorEmail: string;
	password: string;
	telegramBotToken: string | null;
	telegramBotUsername: string | null;
	publicUrl: string | null;
	setTelegramWebhook: boolean;
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

const SAMPLE_LEADS: DemoLead[] = [
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
				text: "Здравствуйте, хочу поменять 500 USDT TRC20 на баты.",
			},
			{
				role: "assistant",
				text: "Здравствуйте. Принял: 500 USDT в сети TRC20. Получение хотите наличными в офисе или переводом на тайский банк?",
			},
		],
	},
	{
		key: "quote-confirmed",
		stage: "quote_calculated",
		name: "Мария Соколова",
		telegramId: "demo_exchange_002",
		fields: {
			exchange_rate: 36.05,
			thb_amount: 72100,
			rate_confirmed: true,
		},
		messages: [
			{ role: "user", text: "Сколько получу за 2000 USDT?" },
			{
				role: "assistant",
				text: "По текущей approved rate-card: 2000 USDT TRC20 -> 72 100 THB. Зафиксировать заявку?",
			},
			{ role: "user", text: "Да, фиксируем. Получение в Bangkok Asok." },
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
			{ role: "user", text: "Нужно 180000 бат, рублями с карты." },
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
			direction: "RUB->THB",
			assetFrom: "RUB",
			network: "",
			amountFrom: 468000,
			rate: 2.6,
			amountToThb: 180000,
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
			requisites_text: "USDT TRC20 wallet: TLEdemoUSDTTRC20Wallet1111111111111",
			requisites_ttl: 30,
		},
		messages: [
			{ role: "user", text: "Подтверждаю 1000 USDT, выдача Phuket Central." },
			{
				role: "assistant",
				text: "Заявка создана. Отправьте 1000 USDT TRC20 на кошелёк TLEdemoUSDTTRC20Wallet1111111111111. Реквизиты действуют 30 минут.",
			},
		],
		order: {
			status: "awaiting_payment",
			direction: "USDT->THB",
			assetFrom: "USDT",
			network: "trc20",
			amountFrom: 1000,
			rate: 36.05,
			amountToThb: 36050,
			paymentMethod: "crypto_transfer",
			paymentRail: "trc20",
			payoutMethod: "office_cash",
			payoutLocation: "phuket_central",
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
				text: "Спасибо, вижу хэш. Передал оплату на проверку, после подтверждения подготовим выдачу THB.",
			},
		],
		order: {
			status: "paid",
			direction: "USDT->THB",
			assetFrom: "USDT",
			network: "trc20",
			amountFrom: 335,
			rate: 36.05,
			amountToThb: 12077,
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
			final_thb_paid: 50000,
			payout_code_final: "LE-4881",
		},
		messages: [
			{ role: "user", text: "Чек отправила, деньги дошли?" },
			{
				role: "human",
				text: "Оплата подтверждена. Выдача 50 000 THB готова в Bangkok Asok, код LE-4881.",
			},
			{ role: "user", text: "Получила, спасибо!" },
		],
		order: {
			status: "completed",
			direction: "RUB->THB",
			assetFrom: "RUB",
			network: "",
			amountFrom: 130000,
			rate: 2.6,
			amountToThb: 50000,
			paymentMethod: "card_transfer",
			paymentRail: "rub_card",
			payoutMethod: "office_cash",
			payoutLocation: "bangkok_asok",
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
			direction: "USDT->THB",
			assetFrom: "USDT",
			network: "trc20",
			amountFrom: 150,
			rate: 35.95,
			amountToThb: 5393,
			paymentMethod: "crypto_transfer",
			paymentRail: "trc20",
			payoutMethod: "office_cash",
			riskJson: { decision: "cancelled_by_customer" },
		},
	},
];

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
		publicUrl: process.env.PLATFORM_PUBLIC_URL ?? null,
		setTelegramWebhook: false,
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
		else if (rawKey === "public-url") out.publicUrl = value;
	}

	return {
		slug: out.slug ?? DEFAULT_SLUG,
		ownerEmail: out.ownerEmail ?? DEFAULT_OWNER_EMAIL,
		operatorEmail: out.operatorEmail ?? DEFAULT_OPERATOR_EMAIL,
		password: out.password ?? DEFAULT_PASSWORD,
		telegramBotToken: out.telegramBotToken ?? null,
		telegramBotUsername: normalizeTelegramUsername(
			out.telegramBotUsername ?? null,
		),
		publicUrl: normalizePublicUrl(out.publicUrl ?? null),
		setTelegramWebhook: out.setTelegramWebhook ?? false,
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
					brandName: "Lead Engine Exchange Demo",
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
						brandName: "Lead Engine Exchange Demo",
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

		await tx
			.insert(llmProviderConfigs)
			.values({
				tenantId: input.tenantId,
				purpose: "chat",
				provider: "openai",
				model: "gpt-4o-mini",
				createdAt: input.now,
				updatedAt: input.now,
			})
			.onConflictDoUpdate({
				target: [llmProviderConfigs.tenantId, llmProviderConfigs.purpose],
				set: {
					provider: "openai",
					model: "gpt-4o-mini",
					updatedAt: input.now,
				},
			});

		return {
			webChannelId: web.id,
			telegramChannelId,
			telegramUsername,
		};
	});
}

async function seedExchangeFunnel(input: {
	db: Db;
	tenantId: number;
	ownerAdminId: number;
	now: number;
}): Promise<{ funnelId: number; stagesCreated: number }> {
	const seeded = await seedFunnelByKey(
		input.db,
		input.tenantId,
		"exchange",
		input.ownerAdminId,
	);
	if ("error" in seeded) throw new Error(`seedFunnel: ${seeded.error}`);
	await withTenant(input.db, input.tenantId, async (tx) => {
		await tx
			.update(funnels)
			.set({
				verticalTemplateId: "exchange_v1",
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
	return seeded;
}

async function seedSampleKb(input: {
	db: Db;
	tenantId: number;
	now: number;
}): Promise<number> {
	const dir = resolve(__dirname, "..", "kb-samples", "exchange");
	const files = ["faq.md", "how-to-pay.md"];
	let count = 0;
	await withTenant(input.db, input.tenantId, async (tx) => {
		for (const file of files) {
			const path = resolve(dir, file);
			if (!existsSync(path)) throw new Error(`KB sample missing: ${path}`);
			const text = readFileSync(path, "utf8");
			const source = `kb-samples/exchange/${basename(file)}`;
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
					title: `Exchange sample: ${basename(file, ".md")}`,
					contentHash: stableHash(text),
					topic: "exchange",
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

async function loadStageContext(input: {
	db: Db;
	tenantId: number;
	funnelId: number;
}) {
	return withTenant(input.db, input.tenantId, async (tx) => {
		const stageRows = await tx
			.select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
			.from(stageDefinitions)
			.where(eq(stageDefinitions.funnelId, input.funnelId));
		const fieldRows = await tx
			.select({
				id: stageFields.id,
				slug: stageFields.slug,
				stageSlug: stageDefinitions.slug,
			})
			.from(stageFields)
			.innerJoin(stageDefinitions, eq(stageDefinitions.id, stageFields.stageId))
			.where(eq(stageDefinitions.funnelId, input.funnelId));

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
	funnelId: number;
	now: number;
}): Promise<{ leads: number; messages: number; orders: number }> {
	await cleanDemoRows({
		db: input.db,
		tenantId: input.tenantId,
		slug: input.slug,
	});
	const { stageIdBySlug, fieldIdByStage } = await loadStageContext({
		db: input.db,
		tenantId: input.tenantId,
		funnelId: input.funnelId,
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
					status: sample.stage === "payout_or_completion" ? "resolved" : "open",
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
		const funnelResult = await seedExchangeFunnel({
			db,
			tenantId,
			ownerAdminId,
			now,
		});
		const fixtureResult = await seedExchangeFixtures({
			db,
			tenantId,
			masterKeyHex,
		});
		const sampleKbDocs = await seedSampleKb({ db, tenantId, now });
		const workflowResult = await seedDemoWorkflow({
			db,
			tenantId,
			slug: args.slug,
			channelId: channelResult.telegramChannelId ?? channelResult.webChannelId,
			operatorAdminId,
			funnelId: funnelResult.funnelId,
			now,
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
					channels: {
						webChannelId: channelResult.webChannelId,
						telegramChannelId: channelResult.telegramChannelId,
						telegramUsername: channelResult.telegramUsername,
						telegramWebhookSet: webhookSet,
					},
					funnel: {
						id: funnelResult.funnelId,
						verticalTemplateId: "exchange_v1",
						stagesCreated: funnelResult.stagesCreated,
					},
					fixtures: fixtureResult,
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
