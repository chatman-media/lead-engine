import { afterEach, describe, expect, it } from "bun:test";
import {
  WestWalletApiError,
  WestWalletClient,
  westWalletCurrencyCandidates,
} from "./westwallet.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("westWalletCurrencyCandidates", () => {
  it("maps common exchange assets/networks to WestWallet currency candidates", () => {
    expect(westWalletCurrencyCandidates("USDT", "trc20")[0]).toBe("USDTTRC");
    expect(westWalletCurrencyCandidates("USDT", "erc20")).toContain("USDTERC");
    expect(westWalletCurrencyCandidates("USDT", "bep20")).toContain("USDTBEP");
    expect(westWalletCurrencyCandidates("USDT", "ton")).toContain("USDTTON");
    expect(westWalletCurrencyCandidates("USDT", "solana")).toContain("USDTSOL");
    expect(westWalletCurrencyCandidates("USDC", "erc20")).toContain("USDC");
    expect(westWalletCurrencyCandidates("USDC", "sol")).toContain("USDCSOL");
    expect(westWalletCurrencyCandidates("ETH", "")).toEqual(["ETH"]);
    expect(westWalletCurrencyCandidates("LTC", "")).toEqual(["LTC"]);
    expect(westWalletCurrencyCandidates("TRX", "")).toEqual(["TRX"]);
    expect(westWalletCurrencyCandidates("TON", "")).toEqual(["TON"]);
    expect(westWalletCurrencyCandidates("BTC", "")).toEqual(["BTC"]);
    expect(westWalletCurrencyCandidates("DOGE", "")).toEqual([]);
  });
});

describe("WestWalletClient", () => {
  it("posts signed createInvoice request", async () => {
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
  });

  it("posts signed generateAddress request with a truncated label", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return Response.json({
        error: "ok",
        address: "TMock",
        dest_tag: null,
        currency: "USDTTRC",
        label: "lead-engine-order-1234567890",
      });
    }) as typeof fetch;

    const client = new WestWalletClient(
      { apiKey: "public", secretKey: "private" },
      { baseUrl: "https://api.test" },
    );
    const address = await client.generateAddress({
      currency: "USDTTRC",
      ipnUrl: "https://app.test/webhook/westwallet/7",
      label: "lead-engine-order-1234567890-too-long",
    });

    expect(address.address).toBe("TMock");
    const request = seen[0];
    expect(request).toBeDefined();
    if (!request) throw new Error("fetch was not called");
    expect(request.url).toBe("https://api.test/address/generate");
    expect(request.init.method).toBe("POST");
    expect(JSON.parse(String(request.init.body))).toEqual({
      currency: "USDTTRC",
      ipn_url: "https://app.test/webhook/westwallet/7",
      label: "lead-engine-order-1234567890-t",
    });
  });

  it("sends invoice transaction token as a signed GET query", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return Response.json({
        error: "ok",
        count: 1,
        result: [
          {
            id: 99,
            amount: "100",
            address: "TMock",
            currency: "USDTTRC",
            status: "completed",
          },
        ],
      });
    }) as typeof fetch;

    const client = new WestWalletClient(
      { apiKey: "public", secretKey: "private" },
      { baseUrl: "https://api.test" },
    );
    const transactions = await client.invoiceTransactions("invoice-token");

    expect(transactions.count).toBe(1);
    const request = seen[0];
    expect(request).toBeDefined();
    if (!request) throw new Error("fetch was not called");
    expect(request.url).toBe("https://api.test/address/invoice_transactions?token=invoice-token");
    expect(request.init.method).toBe("GET");
    expect(request.init.body).toBeUndefined();
    expect(request.init.headers).toMatchObject({
      "X-API-KEY": "public",
      "X-ACCESS-SIGN": expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("posts transaction lookup request", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return Response.json({
        error: "ok",
        id: 42,
        amount: "100",
        address: "TMock",
        currency: "USDTTRC",
        status: "pending",
      });
    }) as typeof fetch;

    const client = new WestWalletClient(
      { apiKey: "public", secretKey: "private" },
      { baseUrl: "https://api.test" },
    );
    const transaction = await client.transaction(42);

    expect(transaction.id).toBe(42);
    const request = seen[0];
    expect(request).toBeDefined();
    if (!request) throw new Error("fetch was not called");
    expect(request.url).toBe("https://api.test/wallet/transaction");
    expect(request.init.method).toBe("POST");
    expect(JSON.parse(String(request.init.body))).toEqual({ id: 42 });
  });

  it("throws WestWalletApiError for HTTP and API-level errors", async () => {
    const client = new WestWalletClient(
      { apiKey: "public", secretKey: "private" },
      { baseUrl: "https://api.test" },
    );

    globalThis.fetch = (async () =>
      Response.json({ error: "bad_key" }, { status: 401 })) as unknown as typeof fetch;
    try {
      await client.transaction(1);
      throw new Error("expected HTTP error");
    } catch (err) {
      expect(err).toBeInstanceOf(WestWalletApiError);
      expect((err as WestWalletApiError).code).toBe("bad_key");
    }

    globalThis.fetch = (async () =>
      Response.json({ error: "currency_not_found" })) as unknown as typeof fetch;
    try {
      await client.generateAddress({
        currency: "UNKNOWN",
        ipnUrl: "https://app.test/webhook/westwallet/7",
      });
      throw new Error("expected API error");
    } catch (err) {
      expect(err).toBeInstanceOf(WestWalletApiError);
      expect((err as WestWalletApiError).code).toBe("currency_not_found");
    }
  });
});
