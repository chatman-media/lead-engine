import { describe, expect, it } from "bun:test";
import { WestWalletClient, westWalletCurrencyCandidates } from "./westwallet.ts";

describe("westWalletCurrencyCandidates", () => {
	it("maps common exchange assets/networks to WestWallet currency candidates", () => {
		expect(westWalletCurrencyCandidates("USDT", "trc20")[0]).toBe("USDTTRC");
		expect(westWalletCurrencyCandidates("USDT", "bep20")).toContain("USDTBEP");
		expect(westWalletCurrencyCandidates("USDT", "ton")).toContain("USDTTON");
		expect(westWalletCurrencyCandidates("BTC", "")).toEqual(["BTC"]);
	});
});

describe("WestWalletClient", () => {
	it("posts signed createInvoice request", async () => {
		const oldFetch = globalThis.fetch;
		const seen: Array<{ url: string; init: RequestInit }> = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(url), init: init ?? {} });
			return new Response(
				JSON.stringify({
					error: "ok",
					allowed_currencies_data: [
						{
							address: "TMock",
							amount: "100",
							currency_code: "USDTTRC",
							dest_tag: "",
						},
					],
					expire_at: "2026-01-01 00:15:00",
					token: "tok",
					url: "https://westwallet.io/payment/tok",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;
		try {
			const client = new WestWalletClient(
				{ apiKey: "public", secretKey: "private" },
				{ baseUrl: "https://api.test" },
			);
			const invoice = await client.createInvoice({
				currencies: ["USDTTRC"],
				amount: "100",
				ipnUrl: "https://app.test/webhook/westwallet/7",
				label: "le-7-42",
				ttlMin: 15,
			});
			expect(invoice.token).toBe("tok");
			const request = seen[0];
			expect(request).toBeDefined();
			if (!request) throw new Error("fetch was not called");
			expect(request.url).toBe("https://api.test/address/create_invoice");
			expect(request.init.method).toBe("POST");
			const headers = request.init.headers as Record<string, string>;
			expect(headers["X-API-KEY"]).toBe("public");
			expect(headers["X-ACCESS-SIGN"]).toMatch(/^[a-f0-9]{64}$/);
			expect(JSON.parse(String(request.init.body))).toMatchObject({
				currencies: ["USDTTRC"],
				amount: "100",
				label: "le-7-42",
				ttl: 15,
			});
		} finally {
			globalThis.fetch = oldFetch;
		}
	});
});
