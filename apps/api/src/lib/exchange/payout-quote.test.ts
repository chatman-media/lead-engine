import { describe, expect, it } from "bun:test";
import { applyPayoutAdjustment } from "./payout-quote.ts";

describe("applyPayoutAdjustment", () => {
  it("office/bank payout: точная сумма, без коррекции", () => {
    const office = applyPayoutAdjustment({
      amount: 45_230,
      quoteAsset: "PHP",
      method: "office_cash",
    });
    expect(office.payoutAmount).toBe(45_230);
    expect(office.isAtm).toBe(false);
    expect(office.fee).toBe(0);
    expect(office.codes).toEqual([]);
    expect(office.note).toBe("");

    const bank = applyPayoutAdjustment({
      amount: 45_230,
      quoteAsset: "THB",
      method: "thai_bank_transfer",
    });
    expect(bank.payoutAmount).toBe(45_230);
  });

  it("ATM THB: округляет вниз до шага 500 (дефолт валюты), остаток не выдаётся", () => {
    const r = applyPayoutAdjustment({ amount: 45_230, quoteAsset: "THB", method: "cardless_atm" });
    expect(r.isAtm).toBe(true);
    expect(r.roundStep).toBe(500);
    expect(r.payoutAmount).toBe(45_000);
    expect(r.roundingRemainder).toBe(230);
    expect(r.dispensable).toBe(true);
    expect(r.note).toContain("кратно 500 THB");
    expect(r.note).toContain("остаток 230");
  });

  it("ATM PHP: дефолтный шаг 100", () => {
    const r = applyPayoutAdjustment({ amount: 12_340, quoteAsset: "PHP", method: "atm" });
    expect(r.roundStep).toBe(100);
    expect(r.payoutAmount).toBe(12_300);
    expect(r.roundingRemainder).toBe(40);
  });

  it("ATM: denomination точки переопределяет дефолт валюты", () => {
    const r = applyPayoutAdjustment({
      amount: 12_340,
      quoteAsset: "PHP",
      method: "atm",
      point: { denomination: 1000 },
    });
    expect(r.roundStep).toBe(1000);
    expect(r.payoutAmount).toBe(12_000);
  });

  it("ATM: дробит на коды по лимиту одного снятия (каждый кратен шагу)", () => {
    const r = applyPayoutAdjustment({
      amount: 45_230,
      quoteAsset: "THB",
      method: "cardless_atm",
      point: { denomination: 500, perWithdrawalMax: 20_000 },
    });
    expect(r.payoutAmount).toBe(45_000);
    expect(r.codes).toEqual([20_000, 20_000, 5_000]);
    expect(r.codes.reduce((a, b) => a + b, 0)).toBe(r.payoutAmount);
    for (const c of r.codes) expect(c % r.roundStep).toBe(0);
    expect(r.note).toContain("3 кода");
  });

  it("ATM: ровная кратная сумма — без остатка, один код", () => {
    const r = applyPayoutAdjustment({
      amount: 10_000,
      quoteAsset: "THB",
      method: "cardless_atm",
      point: { denomination: 500, perWithdrawalMax: 20_000 },
    });
    expect(r.payoutAmount).toBe(10_000);
    expect(r.roundingRemainder).toBe(0);
    expect(r.codes).toEqual([10_000]);
    expect(r.note).not.toContain("остаток");
    expect(r.note).not.toContain("кода");
  });

  it("ATM: сумма меньше шага номинала — невыдаваемо", () => {
    const r = applyPayoutAdjustment({ amount: 300, quoteAsset: "THB", method: "cardless_atm" });
    expect(r.dispensable).toBe(false);
    expect(r.payoutAmount).toBe(0);
    expect(r.codes).toEqual([]);
    expect(r.note).toContain("меньше минимального номинала");
  });

  it("курьер: удерживает комиссию fee_fixed + fee_pct", () => {
    const r = applyPayoutAdjustment({
      amount: 10_000,
      quoteAsset: "THB",
      method: "courier_cash",
      point: { feeFixed: 300, feePct: 1 },
    });
    // 300 + 1% от 10000 = 400
    expect(r.fee).toBe(400);
    expect(r.payoutAmount).toBe(9_600);
    expect(r.isAtm).toBe(false);
    expect(r.note).toContain("комиссия 400 THB");
  });

  it("курьер без комиссии — без удержания и пояснения", () => {
    const r = applyPayoutAdjustment({ amount: 10_000, quoteAsset: "THB", method: "courier_cash" });
    expect(r.fee).toBe(0);
    expect(r.payoutAmount).toBe(10_000);
    expect(r.note).toBe("");
  });
});
