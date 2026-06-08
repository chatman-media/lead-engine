import { createHmac } from "node:crypto";

export const WESTWALLET_BASE_URL = "https://api.westwallet.io";

export interface WestWalletCredentials {
	apiKey: string;
	secretKey: string;
}

export interface WestWalletInvoice {
	error: "ok";
	allowed_currencies_data: Array<{
		address: string;
		amount: number | string;
		currency_code: string;
		dest_tag?: string | null;
	}>;
	expire_at: string;
	token: string;
	url: string;
}

export interface WestWalletTransaction {
	id: number;
	amount: number | string;
	address: string;
	dest_tag?: string | null;
	label?: string | null;
	currency: string;
	status: "pending" | "completed" | string;
	blockchain_confirmations?: number;
	blockchain_hash?: string;
	fee?: number | string;
	type?: "send" | "receive" | string;
}

export interface WestWalletInvoiceTransactions {
	error: "ok";
	count: number;
	result: WestWalletTransaction[];
}

export class WestWalletApiError extends Error {
	constructor(
		readonly code: string,
		message = `WestWallet API error: ${code}`,
	) {
		super(message);
		this.name = "WestWalletApiError";
	}
}

function sign(secretKey: string, timestamp: number, payload: string): string {
	return createHmac("sha256", secretKey)
		.update(`${timestamp}${payload}`, "utf8")
		.digest("hex");
}

function jsonPayload(data: Record<string, unknown> | null): string {
	if (!data || Object.keys(data).length === 0) return "";
	return JSON.stringify(data);
}

export class WestWalletClient {
	constructor(
		private readonly creds: WestWalletCredentials,
		private readonly opts: { baseUrl?: string } = {},
	) {}

	async createInvoice(input: {
		currencies: string[];
		amount: string;
		ipnUrl: string;
		successUrl?: string;
		description?: string;
		label?: string;
		ttlMin?: number;
		amountInUsd?: boolean;
	}): Promise<WestWalletInvoice> {
		return this.request<WestWalletInvoice>("POST", "/address/create_invoice", {
			currencies: input.currencies,
			amount: input.amount,
			ipn_url: input.ipnUrl,
			...(input.successUrl ? { success_url: input.successUrl } : {}),
			...(input.description ? { description: input.description } : {}),
			...(input.label ? { label: input.label.slice(0, 30) } : {}),
			...(input.ttlMin ? { ttl: input.ttlMin } : {}),
			...(input.amountInUsd !== undefined ? { amount_in_usd: input.amountInUsd } : {}),
		});
	}

	async generateAddress(input: {
		currency: string;
		ipnUrl: string;
		label?: string;
	}): Promise<{
		error: "ok";
		address: string;
		dest_tag?: string | null;
		currency: string;
		label?: string | null;
	}> {
		return this.request("POST", "/address/generate", {
			currency: input.currency,
			ipn_url: input.ipnUrl,
			...(input.label ? { label: input.label.slice(0, 30) } : {}),
		});
	}

	async invoiceTransactions(token: string): Promise<WestWalletInvoiceTransactions> {
		return this.request("GET", "/address/invoice_transactions", { token });
	}

	async transaction(id: number): Promise<WestWalletTransaction & { error: "ok" }> {
		return this.request("POST", "/wallet/transaction", { id });
	}

	private async request<T extends { error?: string }>(
		method: "GET" | "POST",
		path: string,
		data: Record<string, unknown>,
	): Promise<T> {
		const timestamp = Math.floor(Date.now() / 1000);
		const payload = jsonPayload(data);
		const url = new URL(`${this.opts.baseUrl ?? WESTWALLET_BASE_URL}${path}`);
		const init: RequestInit = {
			method,
			headers: {
				"Content-Type": "application/json",
				"X-API-KEY": this.creds.apiKey,
				"X-ACCESS-TIMESTAMP": String(timestamp),
				"X-ACCESS-SIGN": sign(this.creds.secretKey, timestamp, payload),
			},
		};
		if (method === "GET") {
			for (const [key, value] of Object.entries(data)) url.searchParams.set(key, String(value));
		} else if (payload) {
			init.body = payload;
		}

		const res = await fetch(url, init);
		const body = (await res.json().catch(() => ({}))) as T;
		if (!res.ok) {
			throw new WestWalletApiError(body.error ?? `http_${res.status}`);
		}
		if (body.error && body.error !== "ok") {
			throw new WestWalletApiError(body.error);
		}
		return body;
	}
}

export function westWalletCurrencyCandidates(asset: string, network: string): string[] {
	const a = asset.trim().toUpperCase();
	const n = network.trim().toLowerCase().replace(/-/g, "");
	if (a === "USDT") {
		if (n === "trc20" || n === "tron" || !n) return ["USDTTRC", "USDTTRC20"];
		if (n === "erc20") return ["USDTERC", "USDTERC20", "USDTETH"];
		if (n === "bep20" || n === "bsc") return ["USDTBEP", "USDTBEP20", "USDTBSC"];
		if (n === "ton") return ["USDTTON", "USDTON"];
		if (n === "solana" || n === "sol") return ["USDTSOL", "USDTSOLANA"];
	}
	if (a === "USDC") {
		if (n === "erc20" || !n) return ["USDCERC", "USDCERC20", "USDCETH", "USDC"];
		if (n === "solana" || n === "sol") return ["USDCSOL", "USDCSOLANA"];
	}
	if (a === "BTC") return ["BTC"];
	if (a === "ETH") return ["ETH"];
	if (a === "LTC") return ["LTC"];
	if (a === "TRX") return ["TRX"];
	return [];
}
