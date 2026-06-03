/**
 * Единый источник правды по ключам обменника в tenant_secrets.
 *
 * Импортируется и admin-exchange (allowlist на запись), и admin-onboarding
 * (подсчёт «реквизит задан?» для onboarding-completeness) — чтобы списки не
 * разъехались.
 *
 * Две группы:
 *  - REQUISITE: то, что нужно боту для приёма платежа (кошельки / платёжные
 *    реквизиты). Их наличие гейтит завершение онбординга обменки.
 *  - BUSINESS: бизнес-данные для оператора (контакт, методы выплат, KYC-политика,
 *    часы, адрес). Сохраняются, но рантайм их пока НЕ читает — НЕ гейтят онбординг.
 */

/** Префикс для адресов кошельков: exchange_wallet_<asset>_<network>. */
export const EXCHANGE_WALLET_PREFIX = "exchange_wallet_";

/** Фиксированные ключи реквизитов приёма (помимо wallet-префикса). */
export const EXCHANGE_REQUISITE_FIXED_KEYS = [
  "exchange_fiat_payment_url",
  "exchange_binance_id",
  "exchange_rub_card_requisites",
] as const;

/** Бизнес-настройки (информационные; рантайм пока не использует — см. follow-up). */
export const EXCHANGE_BUSINESS_SETTING_KEYS = [
  "exchange_operator_contact",
  "exchange_payout_methods",
  "exchange_kyc_policy",
  "exchange_working_hours",
  "exchange_office_address",
] as const;

/** Ключ — реквизит приёма (кошелёк или фиксированный платёжный ключ)? */
export function isExchangeRequisiteKey(key: string): boolean {
  return (
    key.startsWith(EXCHANGE_WALLET_PREFIX) ||
    (EXCHANGE_REQUISITE_FIXED_KEYS as readonly string[]).includes(key)
  );
}

/** Ключ разрешён к записи через POST /exchange/requisites (реквизиты ИЛИ бизнес-данные)? */
export function isAllowedExchangeSecretKey(key: string): boolean {
  return (
    isExchangeRequisiteKey(key) ||
    (EXCHANGE_BUSINESS_SETTING_KEYS as readonly string[]).includes(key)
  );
}
