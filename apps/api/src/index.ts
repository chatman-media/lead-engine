import { checkRlsEnforcement } from "@chatman-media/conversation-engine";
import { makeDefaultLogger, makePlatformMetrics } from "@chatman-media/observability";
import { tenants } from "@chatman-media/storage";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { RECRUITMENT_UAE_V1 } from "@chatman-media/vertical-recruitment-uae";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { ChannelRegistry } from "./channel-registry.ts";
import { loadApiConfig } from "./config.ts";
import { makeDb } from "./db.ts";
import { makeMetricsSink } from "./lib/metrics-sink.ts";
import { WebChannelRegistry } from "./lib/web-channel-registry.ts";
import { WebOutboundDispatcher } from "./lib/web-dispatcher.ts";
import { startWebInboundRunner } from "./lib/web-inbound-runner.ts";
import { loadTenantLlmConfigs } from "./lib/llm-config-loader.ts";
import {
  makeEmbedderResolver,
  makeMemoryExtractor,
  makeReplyStrategy,
  makeStageClassifier,
} from "./llm-bootstrap.ts";
import { makeRequireAuth } from "./middleware/require-auth.ts";
import { makeTenantContextMiddleware, requireTenant } from "./middleware/tenant-context.ts";
import { makeAdminChannelsRoutes } from "./routes/admin-channels.ts";
import { makeAdminKbRoutes } from "./routes/admin-kb.ts";
import { makeAdminLlmConfigsRoutes } from "./routes/admin-llm-configs.ts";
import { makeAdminOnboardingRoutes } from "./routes/admin-onboarding.ts";
import { makeAdminRoutes } from "./routes/admin.ts";
import { makeAuthRoutes } from "./routes/auth.ts";
import { makeHealthRoutes } from "./routes/health.ts";
import { makeMetricsRoutes } from "./routes/metrics.ts";
import { makeStripeWebhookRoutes } from "./routes/webhook-stripe.ts";
import { makeTelegramWebhookRoutes } from "./routes/webhook-telegram.ts";
import { makeWhatsAppWebhookRoutes } from "./routes/webhook-whatsapp.ts";
import { makeWebSocketRoutes } from "./routes/ws-web.ts";

/**
 * Mapping tenant.slug → VerticalTemplate. На текущем этапе один tenant —
 * legacy — c hardcoded recruitment_uae_v1. После Этапа 8 будет lookup
 * через funnels.vertical_template_id из БД (per tenant + per funnel).
 */
const TEMPLATE_BY_TENANT_SLUG: Record<string, VerticalTemplate> = {
  legacy: RECRUITMENT_UAE_V1,
};

function resolveTemplate(tenantSlug: string): VerticalTemplate | undefined {
  return TEMPLATE_BY_TENANT_SLUG[tenantSlug];
}

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
  const activeTenantIds = (
    await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"))
  ).map((r) => r.id);
  log.info("active tenants loaded for LLM config", { count: activeTenantIds.length, ids: activeTenantIds });

  // Per-tenant LLM configs: DB (llm_provider_configs) + decrypted secrets,
  // env как fallback для tenants без DB config'а. Hot-reload — TODO.
  const loadedLlmConfigs = await loadTenantLlmConfigs({
    db,
    tenantIds: activeTenantIds,
    envFallback: cfg,
    masterKeyHex: cfg.masterKeyHex,
    onError: (msg, ctx) => log.warn(`llm-config-loader: ${msg}`, ctx),
  });
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
  log.info("auth routes enabled", { tokenSecret: cfg.authSecret ? "configured" : "missing!" });

  // Authenticated admin-API под /api/admin/*. Middleware requireAuth
  // extract'ит Bearer token из Authorization header → выставляет
  // c.var.{adminId, tenantId, role, adminEmail}. Все routes сами
  // wrap'ятся в withTenant для RLS.
  // requireAuth gating /api/admin/* — нужно всегда, даже если embedder
  // не сконфигурирован: /api/admin/llm-configs позволяет настроить LLM
  // через UI без env-vars.
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: cfg.authSecret }));

  const embedderResolver = makeEmbedderResolver(loadedLlmConfigs);
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
  app.route("/", makeAdminLlmConfigsRoutes({ db, masterKeyHex: cfg.masterKeyHex }));
  log.info("admin-llm-configs routes enabled (per-tenant LLM config CRUD)");

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
    }),
  );
  log.info("admin-channels routes enabled (per-tenant channel CRUD)", {
    autoSetWebhook: !!cfg.publicUrl,
  });

  // Onboarding status aggregator (channel + LLM + KB).
  app.route("/", makeAdminOnboardingRoutes({ db }));
  log.info("admin-onboarding route enabled");

  app.route(
    "/",
    makeHealthRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
      db: db as any,
      timeoutMs: cfg.healthCheckTimeoutMs,
    }),
  );
  const replyStrategy = makeReplyStrategy(loadedLlmConfigs, cfg, db, metrics);
  if (replyStrategy) {
    log.info("reply strategy configured", {
      kind: loadedLlmConfigs.anyTenantHasEmbed ? "RAG" : "LLM-only",
      tenants: loadedLlmConfigs.byTenant.size,
      ...(cfg.defaultStyleSlug ? { style: cfg.defaultStyleSlug } : {}),
      ...(cfg.experimentSlug ? { experiment: cfg.experimentSlug } : {}),
    });
  } else {
    log.info("LLM not configured for any tenant — bot will persist messages but stay silent");
  }

  const memoryExtractor = makeMemoryExtractor(loadedLlmConfigs, db, metrics);
  if (memoryExtractor) log.info("memory extractor enabled");

  const stageClassifier = makeStageClassifier(loadedLlmConfigs, cfg, db, metrics);
  if (stageClassifier) {
    log.info("stage classifier enabled", { kind: cfg.stageClassifier });
  }

  const sink = makeMetricsSink(metrics);

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
      sink,
      metrics,
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
    log.info("admin-api routes enabled", { baseDomain: cfg.platformBaseDomain });
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
        sink,
        metrics,
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
    app.route(
      "/",
      makeStripeWebhookRoutes({
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
        db: db as any,
        webhookSecret: cfg.stripeWebhookSecret,
      }),
    );
    log.info("stripe webhook enabled");
  }

  // ---- channel-web wire-up ----
  // WebChannelAdapter держит pinned WS-connection'ы — adapter и
  // dispatcher для web живут в этом процессе, в отличие от
  // telegram/whatsapp где dispatcher в apps/worker. См. комментарий
  // в WebOutboundDispatcher для rationale.
  const webRegistry = new WebChannelRegistry();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
  await webRegistry.loadFromDb(db as any);
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

  log.info("listening", { port: server.port, url: `http://localhost:${server.port}` });

  // Graceful shutdown: дренируем channels, закрываем DB-пул.
  const shutdown = async () => {
    log.info("shutting down");
    server.stop();
    webAbort.abort();
    webDispatcher.stop();
    await Promise.allSettled([webDispatcherPromise, ...webRunners]);
    webRegistry.closeAll();
    channels.closeAll();
    await close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  const log = makeDefaultLogger("apps/api");
  log.error("fatal", { err: err instanceof Error ? err : new Error(String(err)) });
  process.exit(1);
});
