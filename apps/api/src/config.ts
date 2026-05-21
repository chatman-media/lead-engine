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
  /**
   * Bootstrap LLM-config для legacy tenant'а. После Этапа 8 (расшифровка
   * tenant_secrets) этого не будет — конфиг будет читаться из БД per
   * tenant_id. Сейчас минимальный shim для одного-tenant'ного deploy.
   *
   * Пустые значения = не подключать LlmReplyStrategy (бот persist'ит и
   * молчит).
   */
  llm: {
    provider: "openai" | "openrouter" | "ollama" | "";
    model: string;
    apiKey: string;
    baseUrl: string;
  };
  /**
   * Опционально: embedder для RAG. Если все поля заданы (provider+model+
   * apiKey+dim) — apps/api инжектит RagReplyStrategy (KB-aware ответы).
   * Иначе fallback на LlmReplyStrategy (просто history-prompt без KB).
   */
  embed: {
    provider: "openai" | "openrouter" | "ollama" | "";
    model: string;
    apiKey: string;
    baseUrl: string;
    dim: number;
  };
  /**
   * Опционально: slug дефолтного sales-style для legacy tenant'а. Если
   * задан, RagReplyStrategy.resolveStyle подгрузит StylesRepo.findActiveBySlug
   * (с парсингом через @chatman-media/rag StyleSchema) и передаст в
   * answerWithRag. Стиль строит system prompt через composeSystemPrompt
   * (persona + sales framework + hooks + skills).
   *
   * Пусто = answerWithRag fallback на DEFAULT_PERSONA.
   *
   * Доступные styles в legacy tenant'е (после seed-styles script):
   *   alina-infinity-v1, flirty-belfort-v1, empathetic-nepq-v1, cold-direct-pas-v1
   */
  defaultStyleSlug: string;
  /**
   * Стратегия классификации sales-stage'а реплики:
   *   - "regex" — быстрый regex-classifier (русские паттерны recruitment-uae)
   *   - "llm" — LLM-based (использует chat-config), точнее но дороже
   *   - "" (по умолчанию) — выключен, conversation.current_stage не пишется
   */
  stageClassifier: "regex" | "llm" | "";
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`apps/api config: missing env ${name}`);
  }
  return v;
}

export function loadApiConfig(): ApiConfig {
  const provider = (process.env.LLM_PROVIDER ?? "") as ApiConfig["llm"]["provider"];
  const embedProvider = (process.env.LLM_EMBED_PROVIDER ?? "") as ApiConfig["embed"]["provider"];
  return {
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    databaseUrl: required("DATABASE_URL"),
    masterKeyHex: required("PLATFORM_MASTER_KEY"),
    telegramWebhookSecret: required("TELEGRAM_WEBHOOK_SECRET"),
    healthCheckTimeoutMs: Number.parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS ?? "2000", 10),
    llm: {
      provider,
      model: process.env.LLM_MODEL ?? "",
      apiKey: process.env.LLM_API_KEY ?? "",
      baseUrl: process.env.LLM_BASE_URL ?? "",
    },
    embed: {
      provider: embedProvider,
      model: process.env.LLM_EMBED_MODEL ?? "",
      apiKey: process.env.LLM_EMBED_API_KEY ?? process.env.LLM_API_KEY ?? "",
      baseUrl: process.env.LLM_EMBED_BASE_URL ?? "",
      dim: Number.parseInt(process.env.LLM_EMBED_DIM ?? "1536", 10),
    },
    defaultStyleSlug: process.env.STYLE_SLUG ?? "",
    stageClassifier:
      (process.env.STAGE_CLASSIFIER ?? "") as ApiConfig["stageClassifier"],
  };
}
