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
   * Secret для HMAC-SHA256 sign/verify session tokens (admin-API auth).
   * env PLATFORM_AUTH_SECRET. Fallback на PLATFORM_MASTER_KEY если первый
   * не задан — для dev-deploy'ев которые ещё не добавили отдельный env.
   * Production: обязан быть отдельный 32+ byte secret.
   */
  authSecret: string;
  /**
   * Webhook secret для Telegram setWebhook — Telegram пробрасывает
   * заголовок `X-Telegram-Bot-Api-Secret-Token`, мы валидируем его до
   * парсинга payload'а. Один секрет на платформу (per-tenant роутинг —
   * через путь /webhook/telegram/:tenant_slug).
   */
  telegramWebhookSecret: string;
  /**
   * Verify-token для WhatsApp Cloud setup'а (Meta dashboard → Webhooks →
   * Verify Token). Если задан, /webhook/whatsapp/:slug подключается.
   * Пусто = WhatsApp webhook'и не принимаются.
   */
  whatsappVerifyToken: string;
  /**
   * App secret из Meta dashboard → App Settings → Basic. Используется
   * для HMAC-SHA256 валидации `X-Hub-Signature-256` header'а в POST
   * webhook'ах. Если пусто — signature check пропускается (warning
   * на boot). Production deploy ОБЯЗАН задавать.
   */
  whatsappAppSecret: string;
  /**
   * Stripe webhook signing secret (whsec_...) — опционально. Если пусто,
   * /webhook/stripe не подключается и Stripe-billing просто не работает.
   */
  stripeWebhookSecret: string;
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
   * (с парсингом через @chatman-media/kb StyleSchema) и передаст в
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
   * Корневой домен платформы (env PLATFORM_BASE_DOMAIN). Если задан —
   * admin-API routes под /admin/* активируются с tenant-context-middleware:
   * subdomain → c.var.tenantSlug. Без него admin-API отключён (только
   * webhook'и и /metrics + /healthz).
   *
   * Примеры: "leadengine.app", "staging.leadengine.app". В dev оставляем
   * пустым.
   */
  platformBaseDomain: string;
  /**
   * Полный externally-reachable URL apps/api (env PLATFORM_PUBLIC_URL).
   * Используется для авто-setup Telegram webhook'а при channel-create
   * через UI: setWebhook(url=`<publicUrl>/webhook/telegram/<slug>`).
   *
   * Примеры: "https://api.leadengine.app", "https://example.ngrok.io".
   * Если пусто — auto-setWebhook отключается, admin должен настроить
   * webhook вручную после рестарта.
   */
  publicUrl: string;
  /**
   * URL CDN-bundle'а web-widget'а (`/widget.js`). Если задан — admin-UI
   * POST /api/admin/channels/web вернёт production-ready snippet с
   * `<script src=...>`. Пусто = fallback на demo HTML link.
   */
  webWidgetScriptUrl: string;
  /**
   * Slug запущенного эксперимента (status='running' в БД). Если задан,
   * RagReplyStrategy.resolveStyle использует ABRouter поверх variants
   * из experiments.allocation_json (a/b routing by hash(contactId)).
   * Эксперимент имеет приоритет над defaultStyleSlug.
   */
  experimentSlug: string;
  /**
   * Стратегия классификации sales-stage'а реплики:
   *   - "regex" — быстрый regex-classifier (русские паттерны recruitment-uae)
   *   - "llm" — LLM-based (использует chat-config), точнее но дороже
   *   - "" (по умолчанию) — выключен, conversation.current_stage не пишется
   */
  stageClassifier: "regex" | "llm" | "";
  /**
   * Inbound rate limit per tenant. Защита от runaway-волн (spam) которые
   * сжигают LLM credits. Disabled если оба значения = 0.
   *  - perMinute: msg/min/tenant (default 60)
   *  - perHour: msg/hour/tenant (default 600)
   */
  rateLimit: {
    perMinute: number;
    perHour: number;
  };
  /**
   * Stripe checkout / customer portal config. Если `secretKey` пуст —
   * checkout/portal endpoints возвращают 503 (UI disable'ит Upgrade CTA).
   * Webhook handler работает независимо (uses signing secret).
   *
   *  - secretKey: env STRIPE_SECRET_KEY (sk_test_... / sk_live_...)
   *  - priceStarter / pricePro: env STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO
   *    (price_xxx IDs из Stripe dashboard → Products → ...)
   *  - successUrl / cancelUrl: redirect назад в UI после checkout. Tenant
   *    slug подставляется как `{TENANT}` placeholder, например
   *    "https://acme.leadengine.app/dashboard?upgrade=success"
   */
  stripe: {
    secretKey: string;
    priceStarter: string;
    pricePro: string;
    successUrl: string;
    cancelUrl: string;
  };
  /**
   * Channel-web WebSocket-endpoint config:
   *   - `enabled` — поднимается ли вообще (default true когда в БД есть
   *      хотя бы один `channels.kind='web'` row, false иначе — runtime check'нется)
   *   - `authSecret` — опциональный shared-secret для pilot-stage auth
   *     (`?auth=X` в URL). Пусто = auth выключен. Production-grade JWT —
   *     следующая итерация.
   *   - `dispatcherPollMs` / `dispatcherBatchSize` — для in-process
   *     WebOutboundDispatcher (claim'ит kind='web' rows из outbound_queue).
   */
  web: {
    authSecret: string;
    dispatcherPollMs: number;
    dispatcherBatchSize: number;
  };
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
    authSecret: process.env.PLATFORM_AUTH_SECRET ?? required("PLATFORM_MASTER_KEY"),
    telegramWebhookSecret: required("TELEGRAM_WEBHOOK_SECRET"),
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    whatsappAppSecret: process.env.WHATSAPP_APP_SECRET ?? "",
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
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
    platformBaseDomain: process.env.PLATFORM_BASE_DOMAIN ?? "",
    publicUrl: (process.env.PLATFORM_PUBLIC_URL ?? "").replace(/\/$/, ""),
    webWidgetScriptUrl: (process.env.WEB_WIDGET_SCRIPT_URL ?? "").replace(/\/$/, ""),
    defaultStyleSlug: process.env.STYLE_SLUG ?? "",
    experimentSlug: process.env.EXPERIMENT_SLUG ?? "",
    stageClassifier:
      (process.env.STAGE_CLASSIFIER ?? "") as ApiConfig["stageClassifier"],
    web: {
      authSecret: process.env.WEB_WS_AUTH_SECRET ?? "",
      dispatcherPollMs: Number.parseInt(process.env.WEB_DISPATCHER_POLL_MS ?? "200", 10),
      dispatcherBatchSize: Number.parseInt(process.env.WEB_DISPATCHER_BATCH ?? "32", 10),
    },
    rateLimit: {
      perMinute: Number.parseInt(process.env.RATE_LIMIT_PER_MIN ?? "60", 10),
      perHour: Number.parseInt(process.env.RATE_LIMIT_PER_HOUR ?? "600", 10),
    },
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY ?? "",
      priceStarter: process.env.STRIPE_PRICE_STARTER ?? "",
      pricePro: process.env.STRIPE_PRICE_PRO ?? "",
      successUrl: process.env.STRIPE_CHECKOUT_SUCCESS_URL ?? "",
      cancelUrl: process.env.STRIPE_CHECKOUT_CANCEL_URL ?? "",
    },
  };
}
