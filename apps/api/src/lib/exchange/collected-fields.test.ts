import { describe, expect, it } from "bun:test";
import { mapExchangeCollectedValues } from "./tools.ts";

describe("mapExchangeCollectedValues", () => {
  it("маппит собранные поля в аргументы тулов", () => {
    expect(
      mapExchangeCollectedValues({
        asset_from: "usdt",
        amount_from: 2000,
        network: "trc20",
        payout_method: "atm",
      }),
    ).toEqual({
      asset: "usdt",
      amount: 2000,
      network: "trc20",
      payoutMethod: "atm",
    });
  });

  it("нормализует payout office → office_cash и payment sbp → sbp_qr", () => {
    const out = mapExchangeCollectedValues({
      asset_from: "rub",
      amount_from: 20000,
      payout_method: "office",
      payment_method: "sbp_qr",
    });
    expect(out.payoutMethod).toBe("office_cash");
    expect(out.paymentMethod).toBe("sbp_qr");
  });

  it("payment_method card_transfer проходит как есть", () => {
    expect(mapExchangeCollectedValues({ payment_method: "card_transfer" }).paymentMethod).toBe(
      "card_transfer",
    );
  });

  it("amount из строки с пробелами/запятой → число", () => {
    expect(mapExchangeCollectedValues({ amount_from: "20 000" }).amount).toBe(20000);
    expect(mapExchangeCollectedValues({ amount_from: "1500,5" }).amount).toBe(1500.5);
  });

  it("пустые/невалидные значения опускаются", () => {
    expect(mapExchangeCollectedValues({})).toEqual({});
    expect(mapExchangeCollectedValues({ asset_from: "", amount_from: 0 })).toEqual({});
    expect(mapExchangeCollectedValues({ amount_from: "abc" })).toEqual({});
  });

  it("legacy/неизвестные значения payout/payment остаются как есть", () => {
    const out = mapExchangeCollectedValues({
      payout_method: "thai_bank_transfer",
      payment_method: "bank_transfer",
    });
    expect(out.payoutMethod).toBe("thai_bank_transfer");
    expect(out.paymentMethod).toBe("bank_transfer");
  });
});
