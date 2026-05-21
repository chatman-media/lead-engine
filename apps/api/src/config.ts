/**
 * Platform-level конфиг apps/api. Tenant-level конфиг (LLM-keys, bot-tokens)
 * живёт в БД (tenant_secrets, llm_provider_configs) — здесь только то, что
 * нужно процессу до того, как он подключился к БД.
 */
export interface ApiConfig {
  /** PORT, на котором слушает HTTP-сервер. */
  port: number;
  /** Postgres connection string. */
  databaseUrl: string;
  /**
   * Master key для расшифровки tenant_secrets (aes-256-gcm). 32 байта hex.
   * НЕ должен быть в репо — берётся из env / secrets-manager при deploy.
   */
  masterKeyHex: string;
  /**
   * Webhook secret для Telegram setWebhook — Telegram пробрасывает
   * заголовок `X-Telegram-Bot-Api-Secret-Token`, мы валидируем его до
   * парсинга payload'а. Один секрет на платформу (per-tenant роутинг —
   * через путь /webhook/telegram/:tenant_slug).
   */
  telegramWebhookSecret: string;
  /**
   * Опционально: дополнительный fast-path SELECT во время /healthz —
   * если БД лежит, мы возвращаем 503 и трафик переключается на старый
   * sales-guru до восстановления.
   */
  healthCheckTimeoutMs: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`apps/api config: missing env ${name}`);
  }
  return v;
}

export function loadApiConfig(): ApiConfig {
  return {
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    databaseUrl: required("DATABASE_URL"),
    masterKeyHex: required("PLATFORM_MASTER_KEY"),
    telegramWebhookSecret: required("TELEGRAM_WEBHOOK_SECRET"),
    healthCheckTimeoutMs: Number.parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS ?? "2000", 10),
  };
}
