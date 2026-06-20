import { describe, expect, it } from "bun:test";
import { KNOWN_QUOTE_CURRENCIES, QUOTE_CURRENCY, resolveQuoteCurrency } from "./quote-currency.ts";

describe("resolveQuoteCurrency", () => {
  it("null/undefined/пусто → платформенный дефолт", () => {
    expect(resolveQuoteCurrency(null)).toBe(QUOTE_CURRENCY);
    expect(resolveQuoteCurrency(undefined)).toBe(QUOTE_CURRENCY);
    expect(resolveQuoteCurrency("  ")).toBe(QUOTE_CURRENCY);
  });

  it("известный код (THB/PHP) → словарный объект", () => {
    expect(resolveQuoteCurrency("THB")).toBe(KNOWN_QUOTE_CURRENCIES.THB);
    expect(resolveQuoteCurrency("php")).toBe(KNOWN_QUOTE_CURRENCIES.PHP);
    expect(resolveQuoteCurrency(" PHP ")).toBe(KNOWN_QUOTE_CURRENCIES.PHP);
  });

  it("неизвестный код → fallback-объект с самим кодом", () => {
    const r = resolveQuoteCurrency("XYZ");
    expect(r.code).toBe("XYZ");
    expect(r.word).toBe("XYZ");
    expect(r.mentionRe.test("xyz")).toBe(true);
    expect(r.bankLabel).toBe("местный банк");
    expect(r.flag).toBe("");
  });
});
