import { describe, expect, it } from "bun:test";
import {
  EXCHANGE_ADMIN_SETTING_KEYS,
  EXCHANGE_BUSINESS_SETTING_KEYS,
  isAllowedExchangeSecretKey,
  isExchangeRequisiteKey,
} from "./requisite-keys.ts";

describe("isAllowedExchangeSecretKey", () => {
  it("разрешает шаблон поста с курсами (регрессия: фича сохранения шаблона)", () => {
    expect(isAllowedExchangeSecretKey("exchange_rate_post_template")).toBe(true);
  });

  it("разрешает wallet-префикс, фикс-реквизиты, бизнес- и провайдер-ключи", () => {
    expect(isAllowedExchangeSecretKey("exchange_wallet_usdt_trc20")).toBe(true);
    expect(isAllowedExchangeSecretKey("exchange_binance_id")).toBe(true);
    expect(isAllowedExchangeSecretKey("exchange_operator_line")).toBe(true);
    expect(isAllowedExchangeSecretKey("exchange_westwallet_api_key")).toBe(true);
  });

  it("режет неизвестные ключи", () => {
    expect(isAllowedExchangeSecretKey("random_key")).toBe(false);
    expect(isAllowedExchangeSecretKey("exchange_unknown")).toBe(false);
  });

  it("шаблон поста — admin-only: НЕ бизнес-ключ (не отдаётся боту) и НЕ реквизит приёма", () => {
    expect(EXCHANGE_BUSINESS_SETTING_KEYS as readonly string[]).not.toContain(
      "exchange_rate_post_template",
    );
    expect(isExchangeRequisiteKey("exchange_rate_post_template")).toBe(false);
    expect(EXCHANGE_ADMIN_SETTING_KEYS).toContain("exchange_rate_post_template");
  });
});
