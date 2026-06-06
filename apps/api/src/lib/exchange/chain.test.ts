import { afterEach, describe, expect, it } from "bun:test";
import { extractTxHash, verifyTronUsdt } from "./chain.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockJson(json: unknown, ok = true) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(json), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
}

const TO = "TXmyAddr";
const TX = "a".repeat(64);

describe("extractTxHash", () => {
  it("голый 64-hex хеш", () => {
    expect(extractTxHash(TX)).toBe(TX);
  });
  it("из ссылки tronscan (верхний регистр → нижний)", () => {
    expect(extractTxHash(`https://tronscan.org/#/transaction/${TX.toUpperCase()}`)).toBe(TX);
  });
  it("нет хеша → null", () => {
    expect(extractTxHash("нет тут хеша")).toBeNull();
  });
});

describe("verifyTronUsdt", () => {
  it("подтверждённый USDT-перевод на наш адрес ≥ суммы → ok", async () => {
    mockJson({
      confirmed: true,
      contractRet: "SUCCESS",
      trc20TransferInfo: [
        { to_address: TO, from_address: "TFrom", amount_str: "100000000", decimals: 6, symbol: "USDT" },
      ],
    });
    const r = await verifyTronUsdt({ txHash: TX, toAddress: TO, expectedAmount: 100 });
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(100);
    expect(r.fromAddress).toBe("TFrom");
  });

  it("сумма меньше ожидаемой (за вычетом допуска) → ok:false", async () => {
    mockJson({
      confirmed: true,
      contractRet: "SUCCESS",
      trc20TransferInfo: [{ to_address: TO, amount_str: "50000000", decimals: 6, symbol: "USDT" }],
    });
    const r = await verifyTronUsdt({ txHash: TX, toAddress: TO, expectedAmount: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("меньше ожидаемой");
  });

  it("нет перевода USDT на наш адрес → ok:false", async () => {
    mockJson({ confirmed: true, trc20TransferInfo: [{ to_address: "TOther", amount_str: "100000000", symbol: "USDT" }] });
    const r = await verifyTronUsdt({ txHash: TX, toAddress: TO, expectedAmount: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("нет перевода USDT");
  });

  it("транзакция не подтверждена → ok:false", async () => {
    mockJson({ confirmed: false });
    const r = await verifyTronUsdt({ txHash: TX, toAddress: TO, expectedAmount: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("не подтвержд");
  });

  it("contractRet != SUCCESS → ok:false", async () => {
    mockJson({ contractRet: "REVERT" });
    const r = await verifyTronUsdt({ txHash: TX, toAddress: TO, expectedAmount: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Статус транзакции");
  });

  it("ошибка сети → needsOperator", async () => {
    globalThis.fetch = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const r = await verifyTronUsdt({ txHash: TX, toAddress: TO, expectedAmount: 1 });
    expect(r.ok).toBe(false);
    expect(r.needsOperator).toBe(true);
  });
});
