import { checkRlsEnforcement } from "@chatman-media/conversation-engine";
import { InMemoryLlmRouter } from "@chatman-media/llm-router";
import { makeDefaultLogger, makePlatformMetrics } from "@chatman-media/observability";
import { funnels, tenants } from "@chatman-media/storage";
import { RECRUITMENT_V1 } from "@chatman-media/vertical-recruitment";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { ChannelRegistry } from "./channel-registry.ts";
import { loadApiConfig } from "./config.ts";
import { makeDb } from "./db.ts";
import { loadTenantLlmConfigs } from "./lib/llm-config-loader.ts";
import { LlmUsageWriter } from "./lib/llm-usage-writer.ts";
import { makeMetricsSink } from "./lib/metrics-sink.ts";
import { InboundRateLimiter } from "./lib/rate-limiter.ts";
import { makeTenantReloader } from "./lib/tenant-reloader.ts";
import { UserbotChannelRegistry } from "./lib/userbot-channel-registry.ts";
import { UserbotOutboundDispatcher } from "./lib/userbot-dispatcher.ts";
import { startUserbotInboundRunner } from "./lib/userbot-inbound-runner.ts";
import { UserbotLoginStore } from "./lib/userbot-login-store.ts";
import { WebChannelRegistry } from "./lib/web-channel-registry.ts";
import { WebOutboundDispatcher } from "./lib/web-dispatcher.ts";
import { startWebInboundRunner } from "./lib/web-inbound-runner.ts";
import {
  type LoadedRef,
  makeEmbedderResolver,
  makeMemoryExtractor,
  makeReplyStrategy,
  makeStageClassifier,
} from "./llm-bootstrap.ts";
import { makeFieldExtractor } from "./lib/field-extractor.ts";
import { makePhotoProcessor } from "./lib/photo-processor.ts";
import { makeRequireAuth } from "./middleware/require-auth.ts";
import { makeTenantContextMiddleware, requireTenant } from "./middleware/tenant-context.ts";
import { makeAdminRoutes } from "./routes/admin.ts";
import { makeAdminAdminsRoutes } from "./routes/admin-admins.ts";
import { makeAdminAuditRoutes } from "./routes/admin-audit.ts";
import { makeAdminBillingRoutes } from "./routes/admin-billing.ts";
import { makeAdminChannelsRoutes } from "./routes/admin-channels.ts";
import { makeAdminConversationsRoutes } from "./routes/admin-conversations.ts";
import { makeAdminDiagnosticsRoutes } from "./routes/admin-diagnostics.ts";
import { makeAdminKbRoutes } from "./routes/admin-kb.ts";
import { makeAdminLlmConfigsRoutes } from "./routes/admin-llm-configs.ts";
import { makeAdminOnboardingRoutes } from "./routes/admin-onboarding.ts";
import { makeAdminTenantRoutes } from "./routes/admin-tenant.ts";
import { makeAdminLeadsRoutes } from "./routes/admin-leads.ts";
import { makeAdminFunnelRoutes } from "./routes/admin-funnel.ts";
import { makeAuthRoutes } from "./routes/auth.ts";
import { makeHealthRoutes } from "./routes/health.ts";
import { makeMetricsRoutes } from "./routes/metrics.ts";
import { makeStripeWebhookRoutes } from "./routes/webhook-stripe.ts";
import { makeTelegramWebhookRoutes } from "./routes/webhook-telegram.ts";
import { makeWhatsAppWebhookRoutes } from "./routes/webhook-whatsapp.ts";
import { makeWidgetStaticRoutes } from "./routes/widget-static.ts";
import { makeWebSocketRoutes } from "./routes/ws-web.ts";

/** Known vertical templates by slug. */
const KNOWN_TEMPLATES: Record<string, VerticalTemplate> = {
  recruitment_v1: RECRUITMENT_V1,
};

async function main() {
  const cfg = loadApiConfig();
  const log = makeDefaultLogger("apps/api");
  const metrics = makePlatformMetrics();
  const { db, close } = makeDb(cfg.databaseUrl);

  // RLS-guard: миграция 0004 включает FORCE ROW LEVEL SECURITY, но
  // если DATABASE_URL коннектится под superuser / BYPASSRLS-role'ью —
  // policy игнорируется и tenant-isolation как defense-in-depth не
  // работает. Surface'им это в логе на boot.
  const rlsCheck = await checkRlsEnforcement(db);
  if (!rlsCheck.isEnforced) {
    log.warn("RLS not enforced — connection role bypasses row-level security", {
      role: rlsCheck.role,
      isSuperuser: rlsCheck.isSuperuser,
      hasBypassRls: rlsCheck.hasBypassRls,
      remediation:
        "Use a NOSUPERUSER NOBYPASSRLS Postgres role for apps/api connection. See migration 0004 comments.",
    });
  } else {
    log.info("RLS enforced", { role: rlsCheck.role });
  }

  // Загружаем active tenant IDs для регистрации LLM-config'а per-tenant.
  // Single-tenant legacy путь использовал hardcoded tenantId=1; в multi-tenant
  // need register config для каждого tenant'а иначе InMemoryLlmRouter throws
  // "LLM config not set: tenantId=X" когда inbound приходит от не-1 tenant.
  // Hot-reload не делаем — новый tenant onboarding требует рестарта apps/api.
  const activeTenantRows = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  const activeTenantIds = activeTenantRows.map((r) => r.id);
  log.info("active tenants loaded for LLM config", {
    count: activeTenantIds.length,
    ids: activeTenantIds,
  });

  // Строим mapping tenantSlug → VerticalTemplate из funnels.vertical_template_id.
  // На старте читаем один раз; новый tenant требует рестарта (acceptable trade-off).
  const templateByTenantSlug: Record<string, VerticalTemplate> = {};
  if (activeTenantRows.length > 0) {
    const funnelRows = await db
      .select({ tenantId: funnels.tenantId, verticalTemplateId: funnels.verticalTemplateId })
      .from(funnels)
      .where(eq(funnels.isActive, true));
    const tenantIdToSlug = new Map(activeTenantRows.map((r) => [r.id, r.slug]));
    for (const row of funnelRows) {
      if (!row.verticalTemplateId) continue;
      const slug = tenantIdToSlug.get(row.tenantId);
      if (!slug) continue;
      const tpl = KNOWN_TEMPLATES[row.verticalTemplateId];
      if (tpl) templateByTenantSlug[slug] = tpl;
    }
  }
  // Hardcoded fallback for the legacy tenant if not already covered.
  if (!templateByTenantSlug.legacy) {
    templateByTenantSlug.legacy = RECRUITMENT_V1;
  }
  const resolveTemplate = (tenantSlug: string): VerticalTemplate | undefined =>
    templateByTenantSlug[tenantSlug];

  // Per-tenant LLM configs: DB + env fallback. LoadedRef shared между
  // фабриками + tenant-reloader (mutable; reload через admin API меняет
  // .current snapshot и router.setConfig, фабрики reflect'ят через
  // closures без рестарта).
  const loadedLlmConfigs = await loadTenantLlmConfigs({
    db,
    tenantIds: activeTenantIds,
    envFallback: cfg,
    masterKeyHex: cfg.masterKeyHex,
    onError: (msg, ctx) => log.warn(`llm-config-loader: ${msg}`, ctx),
  });
  const loadedRef: LoadedRef = {
    current: loadedLlmConfigs,
    router: new InMemoryLlmRouter(),
  };
  log.info("llm configs resolved", {
    tenants: loadedLlmConfigs.byTenant.size,
    anyChat: loadedLlmConfigs.anyTenantHasChat,
    anyEmbed: loadedLlmConfigs.anyTenantHasEmbed,
  });

  const channels = new ChannelRegistry();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
  await channels.loadFromDb(db as any, {
    masterKeyHex: cfg.masterKeyHex,
    onWarn: (msg, ctx) => log.warn(`channel-registry: ${msg}`, ctx),
  });

  const app = new Hono();

  app.route("/", makeMetricsRoutes(metrics));

  // Static: widget bundle + demo HTML. Public routes (без auth), CORS open
  // — widget script загружается с customer-домена.
  app.route("/", makeWidgetStaticRoutes());

  // Auth routes — public (POST /api/auth/signup, /login, /logout, GET /me).
  // НЕ wrap'аются в tenant-middleware: signup создаёт tenant, login
  // резолвит его из email.
  app.route(
    "/",
    makeAuthRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
      db: db as any,
      secret: cfg.authSecret,
    }),
  );
  log.info("auth routes enabled", {
    tokenSecret: cfg.authSecret ? "configured" : "missing!",
  });

  // Authenticated admin-API под /api/admin/*. Middleware requireAuth
  // extract'ит Bearer token из Authorization header → выставляет
  // c.var.{adminId, tenantId, role, adminEmail}. Все routes сами
  // wrap'ятся в withTenant для RLS.
  // requireAuth gating /api/admin/* — нужно всегда, даже если embedder
  // не сконфигурирован: /api/admin/llm-configs позволяет настроить LLM
  // через UI без env-vars.
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: cfg.authSecret }));

  // Web channel registry — early init чтобы reloader мог его перестраивать
  // при POST /api/admin/channels/web. WS-runner / dispatcher поднимутся ниже.
  const webRegistry = new WebChannelRegistry();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
  await webRegistry.loadFromDb(db as any);

  // Userbot (personal-account MTProto) registry + login-store — early init
  // чтобы reloader мог подключать/тушить userbot'ы при onboarding/delete.
  // Runner-factory + loadFromDb выставляются ниже (нужны pipeline-deps).
  const userbotRegistry = new UserbotChannelRegistry({
    apiId: cfg.telegramUserbot.apiId,
    apiHash: cfg.telegramUserbot.apiHash,
    masterKeyHex: cfg.masterKeyHex,
    log,
  });
  const userbotEnabled = cfg.telegramUserbot.apiId > 0 && !!cfg.telegramUserbot.apiHash;
  const userbotLoginStore = userbotEnabled ? new UserbotLoginStore() : undefined;

  // Hot-reload bus: admin routes вызывают reloadLlm/reloadChannels(tenantId)
  // после изменения, live применяя в текущем процессе. apps/worker — отдельный
  // процесс, ему пока нужен restart.
  const reloader = makeTenantReloader({
    db,
    cfg,
    ref: loadedRef,
    registry: channels,
    webRegistry,
    userbotRegistry,
    log: (msg, ctx) => log.info(`reloader: ${msg}`, ctx ?? {}),
  });

  // LLM usage writer — batched DB writes для billing dashboard.
  // Каждый wrapChatClient/wrapEmbeddingClient вызов append'ит event
  // через recordUsage callback. Writer flush'ает каждые 5 сек или при
  // overflow buffer'а (200 events).
  const usageWriter = new LlmUsageWriter({
    db,
    onError: (err, dropped) =>
      log.warn("llm-usage-writer flush failed", {
        err: err instanceof Error ? err.message : String(err),
        droppedEvents: dropped,
      }),
  });
  const recordUsage = (tenantId: number, ev: Parameters<typeof usageWriter.record>[1]) =>
    usageWriter.record(tenantId, ev);

  const embedderResolver = makeEmbedderResolver(loadedRef);
  if (embedderResolver) {
    app.route("/", makeAdminKbRoutes({ db, resolveEmbedder: embedderResolver }));
    log.info("admin-kb routes enabled (KB upload + list + delete)");
  } else {
    log.info("admin-kb routes disabled — no tenant has embed config (DB or env)");
  }

  // Per-tenant LLM provider config CRUD (GET/PUT/DELETE /api/admin/llm-configs).
  // NB: изменения вступают в силу после рестарта apps/api — текущий
  // InMemoryLlmRouter резолвится на boot из env + activeTenantIds.
  // Hot-reload — отдельный PR.
  app.route(
    "/",
    makeAdminLlmConfigsRoutes({
      db,
      masterKeyHex: cfg.masterKeyHex,
      onReload: reloader.reloadLlm,
    }),
  );
  log.info("admin-llm-configs routes enabled (per-tenant LLM config CRUD + hot-reload)");

  // Per-tenant channel CRUD (Telegram bot onboarding по token-paste).
  // Token validate'ится через Telegram getMe, encrypted в tenant_secrets.
  // Если PLATFORM_PUBLIC_URL задан — auto-setWebhook на Telegram при create.
  // Channels подхватываются ChannelRegistry на boot — restart нужен для
  // дальнейшей обработки inbound, но webhook уже указывает сюда.
  app.route(
    "/",
    makeAdminChannelsRoutes({
      db,
      masterKeyHex: cfg.masterKeyHex,
      ...(cfg.publicUrl ? { publicUrl: cfg.publicUrl } : {}),
      webhookSecret: cfg.telegramWebhookSecret,
      ...(cfg.whatsappVerifyToken ? { whatsappVerifyToken: cfg.whatsappVerifyToken } : {}),
      ...(cfg.webWidgetScriptUrl ? { webWidgetScriptUrl: cfg.webWidgetScriptUrl } : {}),
      ...(userbotEnabled ? { telegramApiId: cfg.telegramUserbot.apiId } : {}),
      ...(userbotEnabled ? { telegramApiHash: cfg.telegramUserbot.apiHash } : {}),
      ...(userbotLoginStore ? { userbotLoginStore } : {}),
      onReload: reloader.reloadChannels,
    }),
  );
  log.info("admin-channels routes enabled (per-tenant channel CRUD + hot-reload)", {
    autoSetWebhook: !!cfg.publicUrl,
  });

  // Onboarding status aggregator (channel + LLM + KB).
  app.route("/", makeAdminOnboardingRoutes({ db }));
  log.info("admin-onboarding route enabled");

  // Read-only conversations + messages для admin-UI inbox.
  app.route("/", makeAdminConversationsRoutes({ db }));
  log.info("admin-conversations routes enabled (list + thread + reply)");

  // Audit log read API.
  app.route("/", makeAdminAuditRoutes({ db }));
  log.info("admin-audit routes enabled (read-only)");

  // Multi-admin invite (Q3'26 M4) — token-link flow без email-infrastructure.
  app.route(
    "/",
    makeAdminAdminsRoutes({
      db,
      ...(cfg.publicUrl ? { publicUrl: cfg.publicUrl } : {}),
    }),
  );
  log.info("admin-admins routes enabled (invite / list / revoke)");

  // Tenant info + pause/resume.
  app.route("/", makeAdminTenantRoutes({ db, onStatusChange: reloader.reloadChannels }));
  log.info("admin-tenant routes enabled (pause/resume)");

  // Leads pipeline (list, create, stage transition, field values).
  app.route("/", makeAdminLeadsRoutes({ db }));
  log.info("admin-leads routes enabled");

  // Funnel builder (stage_definitions, stage_fields) + skills list.
  app.route("/", makeAdminFunnelRoutes({ db }));
  log.info("admin-funnel routes enabled");

  // Diagnostics — health-check для tenant setup'а.
  // resolveChat передаём для ?live=1 LLM smoke-test (стоит ~1 токен).
  app.route(
    "/",
    makeAdminDiagnosticsRoutes({
      db,
      masterKeyHex: cfg.masterKeyHex,
      resolveChat: (tenantId) => loadedRef.router.resolveChat(tenantId, "chat"),
    }),
  );
  log.info("admin-diagnostics route enabled");

  // Billing & plan tiers — quota gating + Stripe checkout/portal (M1b).
  app.route(
    "/",
    makeAdminBillingRoutes({
      db,
      ...(cfg.stripe.secretKey
        ? {
            stripe: {
              secretKey: cfg.stripe.secretKey,
              priceMap: {
                ...(cfg.stripe.priceStarter ? { starter: cfg.stripe.priceStarter } : {}),
                ...(cfg.stripe.pricePro ? { pro: cfg.stripe.pricePro } : {}),
              },
              successUrl: cfg.stripe.successUrl,
              cancelUrl: cfg.stripe.cancelUrl,
            },
          }
        : {}),
    }),
  );
  log.info("admin-billing routes enabled", {
    plansEnabled: true,
    stripeEnabled: !!cfg.stripe.secretKey,
  });

  app.route(
    "/",
    makeHealthRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
      db: db as any,
      timeoutMs: cfg.healthCheckTimeoutMs,
    }),
  );
  const replyStrategy = makeReplyStrategy(loadedRef, cfg, db, metrics, recordUsage);
  if (replyStrategy) {
    log.info("reply strategy configured", {
      kind: loadedRef.current.anyTenantHasEmbed ? "RAG" : "LLM-only",
      tenants: loadedRef.current.byTenant.size,
      ...(cfg.defaultStyleSlug ? { style: cfg.defaultStyleSlug } : {}),
      ...(cfg.experimentSlug ? { experiment: cfg.experimentSlug } : {}),
    });
  } else {
    log.info("LLM not configured for any tenant — bot will persist messages but stay silent");
  }

  const memoryExtractor = makeMemoryExtractor(loadedRef, db, metrics, recordUsage);
  if (memoryExtractor) log.info("memory extractor enabled");

  const stageClassifier = makeStageClassifier(loadedRef, cfg, db, metrics, recordUsage);
  if (stageClassifier) {
    log.info("stage classifier enabled", { kind: cfg.stageClassifier });
  }

  const photoProcessor = makePhotoProcessor(loadedRef);
  log.info("photo processor enabled (activates per-tenant when vision LLM is configured)");

  const fieldExtractor = makeFieldExtractor(loadedRef);
  log.info("field extractor enabled (activates per-tenant when chat LLM is configured)");

  const sink = makeMetricsSink(metrics);

  // Per-tenant inbound rate-limit. Disabled если оба значения = 0.
  const rateLimiter =
    cfg.rateLimit.perMinute > 0 || cfg.rateLimit.perHour > 0
      ? new InboundRateLimiter({
          perMinute: cfg.rateLimit.perMinute,
          perHour: cfg.rateLimit.perHour,
        })
      : undefined;
  if (rateLimiter) {
    log.info("inbound rate-limit enabled", {
      perMinute: cfg.rateLimit.perMinute,
      perHour: cfg.rateLimit.perHour,
    });
  } else {
    log.warn("inbound rate-limit disabled — runaway-cost protection off");
  }

  app.route(
    "/",
    makeTelegramWebhookRoutes({
      db,
      channels,
      webhookSecret: cfg.telegramWebhookSecret,
      replyStrategy,
      resolveTemplate,
      memoryExtractor,
      stageClassifier,
      photoProcessor,
      fieldExtractor,
      sink,
      metrics,
      ...(rateLimiter ? { rateLimiter } : {}),
    }),
  );

  // Admin-API под /admin/*: tenant resolved из subdomain через
  // makeTenantContextMiddleware (P), затем requireTenant guard 404'ит
  // если запрос пришёл на apex. Auth (JWT) добавится отдельным коммитом
  // когда apps/admin-ui начнёт wire-up'аться — сейчас все endpoints
  // публичны.
  if (cfg.platformBaseDomain) {
    app.use("/admin/*", makeTenantContextMiddleware({ baseDomain: cfg.platformBaseDomain }));
    app.use("/admin/*", requireTenant);
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeAdminRoutes({ db: db as any }));
    log.info("admin-api routes enabled", {
      baseDomain: cfg.platformBaseDomain,
    });
  }

  if (cfg.whatsappVerifyToken) {
    app.route(
      "/",
      makeWhatsAppWebhookRoutes({
        db,
        channels,
        verifyToken: cfg.whatsappVerifyToken,
        ...(cfg.whatsappAppSecret ? { appSecret: cfg.whatsappAppSecret } : {}),
        replyStrategy,
        resolveTemplate,
        memoryExtractor,
        stageClassifier,
        photoProcessor,
        fieldExtractor,
        sink,
        metrics,
        ...(rateLimiter ? { rateLimiter } : {}),
      }),
    );
    if (!cfg.whatsappAppSecret) {
      log.warn("whatsapp webhook signature verification disabled", {
        remediation: "Set WHATSAPP_APP_SECRET env (Meta dashboard → App Settings → Basic)",
      });
    }
    log.info("whatsapp webhook enabled", {
      signatureCheck: cfg.whatsappAppSecret ? "enabled" : "off (dev mode)",
    });
  }

  if (cfg.stripeWebhookSecret) {
    const priceToPlan: Record<string, "starter" | "pro"> = {};
    if (cfg.stripe.priceStarter) priceToPlan[cfg.stripe.priceStarter] = "starter";
    if (cfg.stripe.pricePro) priceToPlan[cfg.stripe.pricePro] = "pro";
    app.route(
      "/",
      makeStripeWebhookRoutes({
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
        db: db as any,
        webhookSecret: cfg.stripeWebhookSecret,
        priceToPlan,
      }),
    );
    log.info("stripe webhook enabled", {
      knownPrices: Object.keys(priceToPlan).length,
    });
  }

  // ---- channel-web wire-up ----
  // WebChannelAdapter держит pinned WS-connection'ы — adapter и
  // dispatcher для web живут в этом процессе, в отличие от
  // telegram/whatsapp где dispatcher в apps/worker. См. комментарий
  // в WebOutboundDispatcher для rationale.
  // (`webRegistry` уже инициализирован выше — нужен для reloader'а.)
  const webAbort = new AbortController();
  const webRunners: Promise<void>[] = [];
  for (const entry of webRegistry.entries()) {
    const runner = startWebInboundRunner({
      entry,
      db,
      signal: webAbort.signal,
      replyStrategy: replyStrategy ?? null,
      resolveTemplate,
      memoryExtractor,
      stageClassifier,
      sink,
      metrics,
      log,
    });
    webRunners.push(runner);
  }
  const webDispatcher = new WebOutboundDispatcher(db, webRegistry, {
    pollMs: cfg.web.dispatcherPollMs,
    batchSize: cfg.web.dispatcherBatchSize,
    metrics,
    log,
  });
  const webDispatcherPromise = webDispatcher.run(webAbort.signal).catch((err) => {
    log.error("web dispatcher fatal", {
      err: err instanceof Error ? err : new Error(String(err)),
    });
  });

  // ---- Telegram userbot wire-up (personal-account MTProto) ----
  // Та же модель, что web: pinned-соединение + inbound-runner + отдельный
  // outbound-dispatcher живут в apps/api. Registry владеет lifecycle'ом
  // соединений; runner-factory инжектит pipeline-deps (replyStrategy и т.д.).
  const userbotAbort = new AbortController();
  let userbotDispatcherPromise: Promise<void> = Promise.resolve();
  if (userbotEnabled) {
    userbotRegistry.setRunnerFactory((entry, signal) =>
      startUserbotInboundRunner({
        entry,
        db,
        signal,
        replyStrategy: replyStrategy ?? null,
        resolveTemplate,
        memoryExtractor,
        stageClassifier,
        photoProcessor,
        fieldExtractor,
        sink,
        metrics,
        log,
      }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
    await userbotRegistry.loadFromDb(db as any);
    const userbotDispatcher = new UserbotOutboundDispatcher(db, userbotRegistry, {
      pollMs: cfg.telegramUserbot.dispatcherPollMs,
      batchSize: cfg.telegramUserbot.dispatcherBatchSize,
      metrics,
      log,
    });
    userbotDispatcherPromise = userbotDispatcher.run(userbotAbort.signal).catch((err) => {
      log.error("userbot dispatcher fatal", {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    });
    log.info("channel-userbot enabled", { connected: userbotRegistry.size() });
  } else {
    log.info("channel-userbot disabled — TELEGRAM_API_ID/HASH not set");
  }
  const wsRoutes = makeWebSocketRoutes({
    registry: webRegistry,
    log,
    metrics,
    ...(cfg.web.authSecret ? { sharedSecret: cfg.web.authSecret } : {}),
  });
  if (webRegistry.size() > 0) {
    log.info("channel-web enabled", {
      channels: webRegistry.size(),
      authSecret: cfg.web.authSecret ? "configured" : "off (dev mode)",
    });
  }

  const server = Bun.serve({
    port: cfg.port,
    // Кастомный fetch: сначала пытаемся upgrade'нуть WS, иначе — Hono app.
    // Bun.serve.upgrade требует `server` reference, поэтому Hono mount'нуть
    // как простой `fetch: app.fetch` нельзя.
    fetch(req, srv) {
      const upgradeFailure = wsRoutes.tryUpgrade(req, srv);
      if (upgradeFailure) return upgradeFailure;
      // tryUpgrade вернул undefined либо потому что upgrade прошёл (Bun
      // ответит сам), либо потому что URL не /ws/* — отдаём Hono.
      if (new URL(req.url).pathname.startsWith("/ws/")) {
        // upgrade успешен — Bun сам ответит 101. Возвращать здесь нечего,
        // но fetch обязан вернуть Response. Возвращаем заглушку, Bun её
        // не отдаст клиенту т.к. socket уже hijacked.
        return new Response(null, { status: 101 });
      }
      return app.fetch(req, srv);
    },
    websocket: wsRoutes.websocket,
  });

  log.info("listening", {
    port: server.port,
    url: `http://localhost:${server.port}`,
  });

  // Graceful shutdown: дренируем channels, закрываем DB-пул.
  const shutdown = async () => {
    log.info("shutting down");
    server.stop();
    webAbort.abort();
    webDispatcher.stop();
    userbotAbort.abort();
    await Promise.allSettled([webDispatcherPromise, ...webRunners, userbotDispatcherPromise]);
    webRegistry.closeAll();
    await userbotRegistry.closeAll();
    if (userbotLoginStore) await userbotLoginStore.stop();
    channels.closeAll();
    // Flush buffered usage events перед close DB.
    await usageWriter.stop();
    await close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  const log = makeDefaultLogger("apps/api");
  log.error("fatal", {
    err: err instanceof Error ? err : new Error(String(err)),
  });
  process.exit(1);
});
