/**
 * Абстракция провайдера реквизитов (п.12 ТЗ). Источник реквизитов спрятан за
 * PaymentProvider: статические tenant_secrets сейчас, партнёрские API позже.
 *
 * Дефолтная реализация ConfigPaymentProvider берёт реквизиты из tenant_secrets:
 *   - крипта: `exchange_wallet_<asset>_<network>` + optional `_memo` / `_tag`;
 *   - exchange UID rails: Binance / Bybit / HTX;
 *   - фиат: СБП-ссылка или карточные реквизиты;
 *   - WestWallet: если ключи и IPN URL настроены, crypto-инвойс создаётся через API.
 */

import { type Db, getDecryptedSecret } from "@chatman-media/conversation-engine";
import { isCryptoAsset, normNetwork } from "./rates.ts";
import {
	WestWalletApiError,
	WestWalletClient,
	westWalletCurrencyCandidates,
	type WestWalletTransaction,
} from "./westwallet.ts";

export const CRYPTO_TTL_MIN = 15;
export const FIAT_TTL_MIN = 20;

export interface RequisitesResult {
	kind: "crypto" | "fiat";
	/** адрес кошелька (крипта) */
	address?: string;
	network?: string;
	/** memo/tag/destination tag для сетей вроде TON/XRP/XLM или provider invoice */
	destTag?: string;
	/** платёжная ссылка (фиат или WestWallet invoice) */
	paymentUrl?: string;
	/** WestWallet invoice token для последующей проверки */
	invoiceToken?: string;
	expiresAt?: string;
	currencyCode?: string;
	/** Binance/Bybit/HTX/internal exchange id */
	exchangeId?: string;
	exchangeName?: string;
	/** Карточные реквизиты/телефон/банк — показывать как текст, не парсить моделью. */
	detailsText?: string;
	ttlMin: number;
	/** показать AML-предупреждение про входящие переводы */
	amlNote?: boolean;
	/** реквизиты должен выдать оператор (нет настроенного источника) */
	needsOperator?: boolean;
	note?: string;
	/** имя провайдера (для requisites_json/аудита) */
	provider: string;
}

export interface RequisitesInput {
	asset: string; // нормализованный (USDT/RUB/...)
	network: string; // нормализованный lowercase или ''
	amountFrom?: number;
	amountToThb?: number;
	orderId?: number;
	paymentMethod?: string | null;
	paymentRail?: string | null;
}

export interface PaymentProvider {
	readonly name: string;
	getRequisites(input: RequisitesInput): Promise<RequisitesResult>;
}

const EXCHANGE_ACCOUNT_RAILS = [
	{
		rails: ["binance_id", "binance", "binanceid", "p2p_binance"],
		key: "exchange_binance_id",
		displayName: "Binance",
	},
	{
		rails: ["bybit_uid", "bybit_id", "bybit", "bybituid", "p2p_bybit"],
		key: "exchange_bybit_uid",
		displayName: "Bybit",
	},
	{
		rails: ["htx_uid", "htx_id", "htx", "huobi_uid", "huobi_id", "huobi"],
		key: "exchange_htx_uid",
		displayName: "HTX",
	},
] as const;

function formatAmount(n?: number): string | null {
	if (n === undefined || !Number.isFinite(n) || n <= 0) return null;
	return String(Number(n.toFixed(8))).replace(/\.0+$/, "");
}

function compactLines(lines: Array<string | null | undefined>): string | null {
	const out = lines
		.map((line) => line?.trim())
		.filter((line): line is string => Boolean(line));
	return out.length > 0 ? out.join("\n") : null;
}

async function readSecret(deps: { db: Db; tenantId: number; masterKeyHex: string }, key: string) {
	return getDecryptedSecret({
		db: deps.db,
		tenantId: deps.tenantId,
		key,
		masterKeyHex: deps.masterKeyHex,
	});
}

async function readWalletDestTag(
	deps: { db: Db; tenantId: number; masterKeyHex: string },
	walletKey: string,
): Promise<string | undefined> {
	const [memo, tag] = await Promise.all([
		readSecret(deps, `${walletKey}_memo`),
		readSecret(deps, `${walletKey}_tag`),
	]);
	return (memo || tag || undefined)?.trim() || undefined;
}

async function readRubCardDetails(
	deps: { db: Db; tenantId: number; masterKeyHex: string },
): Promise<string | null> {
	const [cardNumber, phone, bank, recipient, legacy] = await Promise.all([
		readSecret(deps, "exchange_rub_card_number"),
		readSecret(deps, "exchange_rub_card_phone"),
		readSecret(deps, "exchange_rub_card_bank"),
		readSecret(deps, "exchange_rub_card_recipient"),
		readSecret(deps, "exchange_rub_card_requisites"),
	]);
	return (
		compactLines([
			cardNumber ? `Карта: ${cardNumber}` : null,
			phone ? `Телефон: ${phone}` : null,
			bank ? `Банк: ${bank}` : null,
			recipient ? `Получатель: ${recipient}` : null,
		]) ?? legacy
	);
}

async function readWestWalletConfig(deps: {
	db: Db;
	tenantId: number;
	masterKeyHex: string;
}): Promise<{
	client: WestWalletClient | null;
	ipnUrl: string | null;
	successUrl: string | null;
}> {
	const [apiKey, secretKey, ipnUrlSecret, successUrlSecret] = await Promise.all([
		readSecret(deps, "exchange_westwallet_api_key"),
		readSecret(deps, "exchange_westwallet_secret_key"),
		readSecret(deps, "exchange_westwallet_ipn_url"),
		readSecret(deps, "exchange_westwallet_success_url"),
	]);
	if (!apiKey || !secretKey) {
		return { client: null, ipnUrl: null, successUrl: successUrlSecret };
	}
	const publicUrl = process.env.PLATFORM_PUBLIC_URL?.replace(/\/+$/, "");
	const ipnUrl = ipnUrlSecret || (publicUrl ? `${publicUrl}/webhook/westwallet/${deps.tenantId}` : null);
	return {
		client: new WestWalletClient({ apiKey, secretKey }),
		ipnUrl,
		successUrl: successUrlSecret,
	};
}

/** Провайдер на основе настроек тенанта (tenant_secrets). */
export class ConfigPaymentProvider implements PaymentProvider {
	readonly name = "config";
	constructor(
		private readonly deps: { db: Db; tenantId: number; masterKeyHex: string },
	) {}

	async getRequisites(input: RequisitesInput): Promise<RequisitesResult> {
		const asset = input.asset.toUpperCase();
		const network = normNetwork(input.network);

		if (isCryptoAsset(asset)) {
			const net = asset === "USDT" && !network ? "trc20" : network;
			const rail = normNetwork(input.paymentRail);
			const exchangeAccount = EXCHANGE_ACCOUNT_RAILS.find((item) =>
				(item.rails as readonly string[]).includes(rail),
			);
			if (exchangeAccount) {
				const exchangeId = await readSecret(this.deps, exchangeAccount.key);
				if (!exchangeId) {
					return {
						kind: "crypto",
						network: exchangeAccount.displayName.toUpperCase(),
						ttlMin: CRYPTO_TTL_MIN,
						needsOperator: true,
						provider: this.name,
						note: `${exchangeAccount.displayName} UID/ID не настроен — выдаёт оператор.`,
					};
				}
				return {
					kind: "crypto",
					exchangeId,
					exchangeName: exchangeAccount.displayName,
					network: exchangeAccount.displayName.toUpperCase(),
					ttlMin: CRYPTO_TTL_MIN,
					provider: this.name,
				};
			}

			const westWallet = await readWestWalletConfig(this.deps);
			const amount = formatAmount(input.amountFrom);
			const currencyCandidates = westWalletCurrencyCandidates(asset, net);
			if (westWallet.client && westWallet.ipnUrl && amount && currencyCandidates.length > 0) {
				for (const currency of currencyCandidates) {
					try {
						const invoice = await westWallet.client.createInvoice({
							currencies: [currency],
							amount,
							ipnUrl: westWallet.ipnUrl,
							...(westWallet.successUrl ? { successUrl: westWallet.successUrl } : {}),
							description: `${asset}${net ? ` ${net.toUpperCase()}` : ""} order ${input.orderId ?? ""}`.trim(),
							label: input.orderId ? `le-${this.deps.tenantId}-${input.orderId}` : undefined,
							ttlMin: CRYPTO_TTL_MIN,
						});
						const [first] = invoice.allowed_currencies_data;
						if (!first?.address) break;
						return {
							kind: "crypto",
							address: first.address,
							network: net.toUpperCase(),
							paymentUrl: invoice.url,
							invoiceToken: invoice.token,
							expiresAt: invoice.expire_at,
							currencyCode: first.currency_code,
							...(first.dest_tag ? { destTag: first.dest_tag } : {}),
							ttlMin: CRYPTO_TTL_MIN,
							amlNote: true,
							provider: "westwallet",
						};
					} catch (err) {
						if (err instanceof WestWalletApiError && err.code === "currency_not_found") {
							continue;
						}
						console.warn("[westwallet] create invoice failed", err);
						break;
					}
				}
			}

			const key = `exchange_wallet_${asset.toLowerCase()}_${net || "default"}`;
			const [address, destTag] = await Promise.all([
				readSecret(this.deps, key),
				readWalletDestTag(this.deps, key),
			]);
			if (!address) {
				return {
					kind: "crypto",
					network: net.toUpperCase(),
					ttlMin: CRYPTO_TTL_MIN,
					amlNote: true,
					needsOperator: true,
					provider: this.name,
					note: `Кошелёк ${asset}/${net.toUpperCase()} не настроен — выдаёт оператор.`,
				};
			}
			return {
				kind: "crypto",
				address,
				...(destTag ? { destTag } : {}),
				network: net.toUpperCase(),
				ttlMin: CRYPTO_TTL_MIN,
				amlNote: true,
				provider: this.name,
			};
		}

		if (input.paymentMethod === "card_transfer") {
			const detailsText = await readRubCardDetails(this.deps);
			if (!detailsText) {
				return {
					kind: "fiat",
					ttlMin: FIAT_TTL_MIN,
					needsOperator: true,
					provider: this.name,
					note: "Карточные RUB-реквизиты не настроены — выдаёт оператор.",
				};
			}
			return { kind: "fiat", detailsText, ttlMin: FIAT_TTL_MIN, provider: this.name };
		}

		const paymentUrl = await readSecret(this.deps, "exchange_fiat_payment_url");
		if (!paymentUrl) {
			return {
				kind: "fiat",
				ttlMin: FIAT_TTL_MIN,
				needsOperator: true,
				provider: this.name,
				note: "Платёжная ссылка/QR не настроены — выдаёт оператор / партнёрский API.",
			};
		}
		return { kind: "fiat", paymentUrl, ttlMin: FIAT_TTL_MIN, provider: this.name };
	}
}

/** Фабрика провайдера тенанта. Точка расширения для партнёрских API. */
export function getPaymentProvider(deps: {
	db: Db;
	tenantId: number;
	masterKeyHex: string;
}): PaymentProvider {
	return new ConfigPaymentProvider(deps);
}

export interface WestWalletVerificationResult {
	ok: boolean;
	transaction: WestWalletTransaction | null;
	needsOperator?: boolean;
	note?: string;
}

export async function verifyWestWalletInvoicePayment(opts: {
	db: Db;
	tenantId: number;
	masterKeyHex: string;
	token: string;
	expectedAmount: number;
}): Promise<WestWalletVerificationResult> {
	const cfg = await readWestWalletConfig(opts);
	if (!cfg.client) {
		return {
			ok: false,
			transaction: null,
			needsOperator: true,
			note: "WestWallet API-ключи не настроены — проверит оператор.",
		};
	}

	const { result } = await cfg.client.invoiceTransactions(opts.token);
	const tx = result.find((item) => item.type === "receive") ?? result[0] ?? null;
	if (!tx) return { ok: false, transaction: null, note: "Платёж по WestWallet invoice пока не найден." };

	if (tx.status !== "completed" && tx.status !== "confirmed") {
		return {
			ok: false,
			transaction: tx,
			note: `WestWallet видит транзакцию, статус ${tx.status}. Ждём подтверждения сети.`,
		};
	}

	const paid = Number(tx.amount);
	if (!Number.isFinite(paid) || paid + 1e-8 < opts.expectedAmount) {
		return {
			ok: false,
			transaction: tx,
			needsOperator: true,
			note: `WestWallet получил ${tx.amount}, ожидалось ${opts.expectedAmount}. Нужна проверка оператора.`,
		};
	}

	return {
		ok: true,
		transaction: tx,
		note: "WestWallet подтвердил входящий платёж. Можно готовить выдачу.",
	};
}
