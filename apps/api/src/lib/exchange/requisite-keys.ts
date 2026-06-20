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
 *  - BUSINESS: бизнес-данные для оператора и бота (контакт, методы выплат,
 *    KYC-политика, часы, адреса офисов). Не гейтят онбординг.
 */

/** Префикс для адресов кошельков: exchange_wallet_<asset>_<network>. */
export const EXCHANGE_WALLET_PREFIX = "exchange_wallet_";

/** Фиксированные ключи реквизитов приёма (помимо wallet-префикса). */
export const EXCHANGE_REQUISITE_FIXED_KEYS = [
  "exchange_fiat_payment_url",
  "exchange_binance_id",
  "exchange_bybit_uid",
  "exchange_htx_uid",
  "exchange_rub_card_requisites",
  "exchange_rub_card_number",
  "exchange_rub_card_phone",
  "exchange_rub_card_bank",
  "exchange_rub_card_recipient",
] as const;

/** Настройки платёжных провайдеров. Не считаются онбординг-реквизитами сами по себе. */
export const EXCHANGE_PROVIDER_SETTING_KEYS = [
  "exchange_westwallet_api_key",
  "exchange_westwallet_secret_key",
  "exchange_westwallet_ipn_url",
  "exchange_westwallet_success_url",
] as const;

/** Ключи, которые нельзя отдавать обратно в UI открытым текстом. */
export const EXCHANGE_SENSITIVE_SECRET_KEYS = [
  "exchange_westwallet_api_key",
  "exchange_westwallet_secret_key",
] as const;

/**
 * Admin-only ключи: разрешены к записи/чтению в админке, но НЕ отдаются боту
 * через get_exchange_business_info и не гейтят онбординг. Для админских хелперов
 * (напр. шаблон поста с курсами — текст для ручной публикации в каналах).
 */
export const EXCHANGE_ADMIN_SETTING_KEYS = [
  "exchange_rate_post_template",
  // JSON-массив имён банков, через которые тенант реально выдаёт наличные
  // (cardless ATM). Пусто/не задан = все банки каталога. Бот фильтрует по нему
  // точки выдачи (list_exchange_payout_points), карта в админке — выделяет их.
  "exchange_payout_banks",
] as const;

/** Бизнес-настройки, доступные runtime через get_exchange_business_info. */
export const EXCHANGE_BUSINESS_SETTING_KEYS = [
  "exchange_operator_contact",
  "exchange_operator_telegram",
  "exchange_operator_whatsapp",
  "exchange_operator_line",
  "exchange_payout_methods",
  "exchange_payout_bank_methods",
  "exchange_payout_cash_methods",
  "exchange_aml_policy",
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
    (EXCHANGE_BUSINESS_SETTING_KEYS as readonly string[]).includes(key) ||
    (EXCHANGE_PROVIDER_SETTING_KEYS as readonly string[]).includes(key) ||
    (EXCHANGE_ADMIN_SETTING_KEYS as readonly string[]).includes(key)
  );
}

export function isSensitiveExchangeSecretKey(key: string): boolean {
  return (EXCHANGE_SENSITIVE_SECRET_KEYS as readonly string[]).includes(key);
}
