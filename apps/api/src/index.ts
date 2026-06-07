import {
  AdminInformer,
  checkRlsEnforcement,
  NotificationsRepo,
  NotificationService,
  OperatorBotHandler,
  OpsAlertRouter,
} from "@chatman-media/conversation-engine";
import { InMemoryLlmRouter } from "@chatman-media/llm-router";
import { makeDefaultLogger, makePlatformMetrics } from "@chatman-media/observability";
import { funnels, tenants } from "@chatman-media/storage";
import { CONCIERGE_V1 } from "@chatman-media/vertical-concierge";
import { EXCHANGE_V1 } from "@chatman-media/vertical-exchange";
import { REAL_ESTATE_V1 } from "@chatman-media/vertical-real-estate";
import { RECRUITMENT_V1 } from "@chatman-media/vertical-recruitment";
import { SAAS_V1 } from "@chatman-media/vertical-saas";
import { VIDEO_V1 } from "@chatman-media/vertical-video";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { ChannelRegistry } from "./channel-registry.ts";
import { loadApiConfig } from "./config.ts";
import { makeDb } from "./db.ts";
import { loadTenantLlmConfigs } from "./lib/llm-config-loader.ts";
import { LlmUsageWriter } from "./lib/llm-usage-writer.ts";
import { checkUsageAlerts } from "./lib/usage-alerts.ts";
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
  type ReplyStrategyBundle,
  makeSimChatResolver,
  makeStageClassifier,
  makeTranscriberResolver,
} from "./llm-bootstrap.ts";
import { makeFieldExtractor } from "./lib/field-extractor.ts";
import { Mailer } from "./lib/mailer.ts";
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
import { makeAdminDashboardRoutes } from "./routes/admin-dashboard.ts";
import { makeAdminReferralRoutes } from "./routes/admin-referral.ts";
import { makeAdminVacanciesRoutes } from "./routes/admin-vacancies.ts";
import { makeAdminDirectorHooksRoutes } from "./routes/admin-director-hooks.ts";
import { makeAdminExperimentsRoutes } from "./routes/admin-experiments.ts";
import { makeAdminEventsRoutes } from "./routes/admin-events.ts";
import { makeAdminOutreachRoutes } from "./routes/admin-outreach.ts";
import { makeAdminOutreachCampaignsRoutes } from "./routes/admin-outreach-campaigns.ts";
import { makeAdminMessageTemplatesRoutes } from "./routes/admin-message-templates.ts";
import { makeAdminStageWebhooksRoutes } from "./routes/admin-stage-webhooks.ts";
import { makeAdminStylesRoutes } from "./routes/admin-styles.ts";
import { makeAdminToolsRoutes } from "./routes/admin-tools.ts";
import { makeAdminExchangeRoutes } from "./routes/admin-exchange.ts";
import { refreshDueTenants } from "./lib/exchange/rate-feed.ts";
import { dripDispatchTick } from "./lib/drip-dispatcher.ts";
import { makeAdminVerticalsRoutes } from "./routes/admin-verticals.ts";
import { makeAdminWorkflowRoutes } from "./routes/admin-workflow.ts";
import { makeAdminCopilotRoutes } from "./routes/admin-copilot.ts";
import { makeAdminNotificationsRoutes } from "./routes/admin-notifications.ts";
import { makeAdminSimRoutes } from "./routes/admin-sim.ts";
import { makeAdminTestRoutes } from "./routes/admin-test.ts";
import { makeMcpRoutes } from "./routes/mcp.ts";
import { makeAuthRoutes } from "./routes/auth.ts";
import { makeSuperadminRoutes } from "./routes/superadmin.ts";
import { makeHealthRoutes } from "./routes/health.ts";
import { makeMetricsRoutes } from "./routes/metrics.ts";
import { makeStripeWebhookRoutes } from "./routes/webhook-stripe.ts";
import { makeTelegramWebhookRoutes } from "./routes/webhook-telegram.ts";
import { makeWhatsAppWebhookRoutes } from "./routes/webhook-whatsapp.ts";
import { makeFacebookWebhookRoutes } from "./routes/webhook-facebook.ts";
import { makeOperatorBotWebhookRoutes } from "./routes/webhook-operator-bot.ts";
import { makeWidgetStaticRoutes } from "./routes/widget-static.ts";
import { makeWebSocketRoutes } from "./routes/ws-web.ts";

/** Known vertical templates by slug. */
const KNOWN_TEMPLATES: Record<string, VerticalTemplate> = {
  concierge_v1: CONCIERGE_V1,
  exchange_v1: EXCHANGE_V1,
  real_estate_v1: REAL_ESTATE_V1,
  recruitment_v1: RECRUITMENT_V1,
  saas_v1: SAAS_V1,
  video_v1: VIDEO_V1,
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
    ...(cfg.whatsappVerifyToken ? { whatsappVerifyTokenFallback: cfg.whatsappVerifyToken } : {}),
    ...(cfg.whatsappAppSecret ? { whatsappAppSecretFallback: cfg.whatsappAppSecret } : {}),
    ...(cfg.facebookVerifyToken ? { facebookVerifyTokenFallback: cfg.facebookVerifyToken } : {}),
    ...(cfg.facebookAppSecret ? { facebookAppSecretFallback: cfg.facebookAppSecret } : {}),
  });

  const app = new Hono();

  app.route("/", makeMetricsRoutes(metrics));

  // Static: widget bundle + demo HTML. Public routes (без auth), CORS open
  // — widget script загружается с customer-домена.
  app.route("/", makeWidgetStaticRoutes());

  // Mailer (Resend) — dry-run если RESEND_API_KEY не задан.
  const mailer = new Mailer({
    apiKey: cfg.mailer.apiKey || undefined,
    fromAddress: cfg.mailer.fromAddress,
  });
  log.info("mailer initialized", { dryRun: !cfg.mailer.apiKey });

  // Auth routes — public (POST /api/auth/signup, /login, /logout, GET /me).
  // НЕ wrap'аются в tenant-middleware: signup создаёт tenant, login
  // резолвит его из email.
  app.route(
    "/",
    makeAuthRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
      db: db as any,
      secret: cfg.authSecret,
      mailer,
      appUrl: cfg.mailer.appUrl,
      allowSignup: process.env.ALLOW_PUBLIC_SIGNUP === "1",
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
  app.use("/api/superadmin/*", makeRequireAuth({ db: db as never, secret: cfg.authSecret }));
  app.route("/", makeSuperadminRoutes({ db }));
  log.info("superadmin routes enabled");

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
  // Userbot-сабсистем включён всегда: api_id/api_hash резолвятся per-tenant из
  // tenant_secrets (env TELEGRAM_API_ID/HASH — лишь общий фолбэк). Тенант вводит
  // свои креды в кабинете → онбординг работает без env на сервере.
  const userbotEnvFallback = cfg.telegramUserbot.apiId > 0 && !!cfg.telegramUserbot.apiHash;
  const userbotLoginStore = new UserbotLoginStore();

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

  const notificationsRepo = new NotificationsRepo(db as any);
  // Информер владельца: единый путь доставки (уровни + дайджест + лента).
  // Mailer структурно — OpsEmailSender (email-гарантия для critical).
  const adminInformer = new AdminInformer({
    db: db as never,
    botToken: cfg.operatorBotToken,
    appUrl: cfg.mailer.appUrl,
    email: mailer,
    log: {
      warn: (m, ctx) => log.warn(m, ctx as Record<string, unknown>),
      info: (m, ctx) => log.info(m, ctx as Record<string, unknown>),
    },
  });
  const notificationService = new NotificationService(
    notificationsRepo,
    cfg.operatorBotToken,
    cfg.mailer.appUrl,
    adminInformer,
  );
  const operatorBotHandler = new OperatorBotHandler(notificationsRepo, cfg.operatorBotToken);
  if (cfg.operatorBotToken) {
    log.info("operator notification bot enabled");
  }
  // Роутер операционных алертов владельцу (#145): делегирует доставку информеру
  // (уровни/дайджест/лента); Mailer остаётся email-гарантией для critical.
  const opsAlertRouter = new OpsAlertRouter({
    db: db as never,
    botToken: cfg.operatorBotToken,
    appUrl: cfg.mailer.appUrl,
    email: mailer,
    informer: adminInformer,
    log: {
      warn: (m, ctx) => log.warn(m, ctx as Record<string, unknown>),
      info: (m, ctx) => log.info(m, ctx as Record<string, unknown>),
    },
  });

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
      ...(cfg.facebookVerifyToken ? { facebookVerifyToken: cfg.facebookVerifyToken } : {}),
      ...(cfg.webWidgetScriptUrl ? { webWidgetScriptUrl: cfg.webWidgetScriptUrl } : {}),
      telegramApiId: cfg.telegramUserbot.apiId,
      telegramApiHash: cfg.telegramUserbot.apiHash,
      userbotLoginStore,
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
  app.route("/", makeAdminConversationsRoutes({ db, notifications: notificationService }));
  log.info("admin-conversations routes enabled (list + thread + reply)");

  // Audit log read API.
  app.route("/", makeAdminAuditRoutes({ db }));
  log.info("admin-audit routes enabled (read-only)");

  // Multi-admin invite — token-link flow + email-delivery через Resend.
  app.route(
    "/",
    makeAdminAdminsRoutes({
      db,
      mailer,
      ...(cfg.publicUrl ? { publicUrl: cfg.publicUrl } : {}),
    }),
  );
  log.info("admin-admins routes enabled (invite / list / revoke)");

  // Tenant info + pause/resume.
  app.route("/", makeAdminTenantRoutes({ db, onStatusChange: reloader.reloadChannels }));
  log.info("admin-tenant routes enabled (pause/resume)");

  // Leads pipeline (list, create, stage transition, field values).
  app.route("/", makeAdminLeadsRoutes({ db, notificationService }));
  app.route(
    "/api/admin/notifications",
    makeAdminNotificationsRoutes({
      repo: notificationsRepo,
      botUsername: cfg.operatorBotUsername,
      notificationService,
      opsRouter: opsAlertRouter,
      opsEmailConfigured: !!cfg.mailer.apiKey,
    }),
  );
  log.info("admin-leads routes enabled");

  // Funnel builder (stage_definitions, stage_fields) + skills list.
  app.route("/", makeAdminFunnelRoutes({ db }));
  app.route("/", makeAdminReferralRoutes({ db }));
  log.info("admin-funnel routes enabled");

  // AI Workflow Builder — диалог с AI для генерации воронки.
  app.route(
    "/",
    makeAdminWorkflowRoutes({
      db,
      resolveChat: (tenantId) => loadedRef.router.resolveChat(tenantId, "chat"),
    }),
  );
  log.info("admin-workflow routes enabled (AI funnel builder)");

  // AI-ассистент админки (copilot) — чат по данным страницы + помощь с
  // онбордингом/воронкой. BYOK через тот же resolveChat, что и workflow.
  app.route(
    "/",
    makeAdminCopilotRoutes({
      db,
      resolveChat: (tenantId) => loadedRef.router.resolveChat(tenantId, "chat"),
    }),
  );
  log.info("admin-copilot routes enabled (page-aware AI assistant)");

  // Dashboard aggregate stats.
  app.route("/", makeAdminDashboardRoutes({ db }));
  log.info("admin-dashboard route enabled");

  // Vacancies CRUD.
  app.route("/", makeAdminVacanciesRoutes({ db }));
  log.info("admin-vacancies routes enabled");

  // Director hooks (tenant-specific persuasion scripts).
  app.route("/", makeAdminDirectorHooksRoutes({ db }));
  log.info("admin-director-hooks routes enabled");
  app.route("/", makeAdminExperimentsRoutes({ db }));
  log.info("admin-experiments routes enabled");
  // admin-styles mounted after strategyBundle (needs onReload → invalidateStyleFor).

  // Real-time SSE push for admin UI.
  app.route("/", makeAdminEventsRoutes());
  log.info("admin SSE events enabled at GET /api/admin/events");

  // Outreach campaigns — batch message sending to leads.
  app.route("/", makeAdminOutreachRoutes({ db }));
  app.route("/", makeAdminOutreachCampaignsRoutes({ db }));
  log.info("admin-outreach routes enabled");

  // Message templates for outreach.
  app.route("/", makeAdminMessageTemplatesRoutes({ db }));
  log.info("admin-message-templates routes enabled");

  // Stage-change webhooks CRUD.
  app.route("/", makeAdminStageWebhooksRoutes({ db }));
  log.info("admin-stage-webhooks routes enabled");

  // Vertical plugin install.
  app.route("/", makeAdminVerticalsRoutes({ db, resolveEmbedder: embedderResolver ?? undefined }));
  log.info("admin-verticals routes enabled");

  // MCP (Model Context Protocol) endpoint — для Claude Desktop / Cursor / агентов.
  app.route(
    "/",
    makeMcpRoutes({
      db,
      authSecret: cfg.authSecret,
      resolveEmbedder: embedderResolver ?? undefined,
    }),
  );
  log.info("MCP endpoint enabled at POST /mcp");

  const strategyBundle: ReplyStrategyBundle | null = makeReplyStrategy(
    loadedRef,
    cfg,
    db,
    metrics,
    recordUsage,
    // A4: rate-guard сработал → алерт владельцу (информер/Telegram), не «тихий» warn.
    (alert) => {
      void notificationService
        .notify({
          tenantId: alert.tenantId,
          eventType: "exchange_rate_guard_tripped",
          conversationId: alert.conversationId,
          data: {
            asset: alert.asset,
            network: alert.network ?? "",
            reason: alert.reason,
            deviationPct: alert.deviationPct,
            threshold: alert.threshold ?? null,
          },
        })
        .catch(() => {});
    },
  );

  // Agentic tool configuration (booking link, etc.).
  app.route(
    "/",
    makeAdminToolsRoutes({
      db,
      masterKeyHex: cfg.masterKeyHex,
      onReload: strategyBundle
        ? (tenantId) => strategyBundle.invalidateToolsFor(tenantId)
        : undefined,
    }),
  );
  log.info("admin-tools routes enabled");

  // Exchange (обменный пункт): курсы/формулы, CRM заявок, оборот, реквизиты.
  app.route(
    "/",
    makeAdminExchangeRoutes({
      db,
      masterKeyHex: cfg.masterKeyHex,
      onReload: strategyBundle
        ? (tenantId) => strategyBundle.invalidateToolsFor(tenantId)
        : undefined,
    }),
  );
  log.info("admin-exchange routes enabled");

  // Sales styles (personas) + AI generate-full. onReload drops the cached style
  // so a generated/edited style drives the bot without a restart (Phase 2 slice B).
  app.route(
    "/",
    makeAdminStylesRoutes({
      db,
      resolveChat: (tenantId) => loadedRef.router.resolveChat(tenantId, "chat"),
      onReload: strategyBundle
        ? (tenantId) => strategyBundle.invalidateStyleFor(tenantId)
        : undefined,
    }),
  );
  log.info("admin-styles routes enabled");

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
  const replyStrategy = strategyBundle?.strategy ?? null;
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

  // Bot Tester — simulate inbound messages through the full pipeline.
  app.route(
    "/",
    makeAdminTestRoutes({
      db,
      replyStrategy: replyStrategy ?? null,
    }),
  );
  log.info("admin-test routes enabled (bot tester)");

  const memoryExtractor = makeMemoryExtractor(loadedRef, db, metrics, recordUsage);
  if (memoryExtractor) log.info("memory extractor enabled");

  const stageClassifier = makeStageClassifier(loadedRef, cfg, db, metrics, recordUsage);
  if (stageClassifier) {
    log.info("stage classifier enabled", { kind: cfg.stageClassifier });
  }

  const photoProcessor = makePhotoProcessor(loadedRef);
  log.info("photo processor enabled (activates per-tenant when vision LLM is configured)");

  const fieldExtractor = makeFieldExtractor(loadedRef, notificationService);
  log.info("field extractor enabled (activates per-tenant when chat LLM is configured)");

  // Dialog Simulator — LLM «клиент» ведёт диалог, виден в живом инбоксе (self_play).
  app.route(
    "/",
    makeAdminSimRoutes({
      db,
      replyStrategy: replyStrategy ?? null,
      resolveSimChat: makeSimChatResolver(loadedRef),
      resolveTemplate,
      stageClassifier,
      fieldExtractor,
    }),
  );
  log.info("admin-sim routes enabled (dialog simulator)");

  const resolveTranscriber = makeTranscriberResolver(loadedRef);
  if (resolveTranscriber) {
    log.info(
      "voice transcription enabled — dedicated 'transcribe' config or OpenAI/OpenRouter key (chat/embed/vision)",
    );
  }

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
      notificationService,
      photoProcessor,
      fieldExtractor,
      sink,
      metrics,
      ...(rateLimiter ? { rateLimiter } : {}),
      ...(resolveTranscriber ? { resolveTranscriber } : {}),
    }),
  );

  app.route(
    "/",
    makeOperatorBotWebhookRoutes({
      handler: operatorBotHandler,
      webhookSecret: cfg.telegramWebhookSecret,
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
        notificationService,
        photoProcessor,
        fieldExtractor,
        sink,
        metrics,
        ...(rateLimiter ? { rateLimiter } : {}),
        ...(resolveTranscriber ? { resolveTranscriber } : {}),
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

  if (cfg.facebookVerifyToken) {
    app.route(
      "/",
      makeFacebookWebhookRoutes({
        db,
        channels,
        verifyToken: cfg.facebookVerifyToken,
        ...(cfg.facebookAppSecret ? { appSecret: cfg.facebookAppSecret } : {}),
        replyStrategy,
        resolveTemplate,
        memoryExtractor,
        stageClassifier,
        notificationService,
        photoProcessor,
        fieldExtractor,
        sink,
        metrics,
        ...(rateLimiter ? { rateLimiter } : {}),
        ...(resolveTranscriber ? { resolveTranscriber } : {}),
      }),
    );
    if (!cfg.facebookAppSecret) {
      log.warn("facebook webhook signature verification disabled", {
        remediation: "Set FACEBOOK_APP_SECRET env (Meta dashboard → App Settings → Basic)",
      });
    }
    log.info("facebook webhook enabled", {
      signatureCheck: cfg.facebookAppSecret ? "enabled" : "off (dev mode)",
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
        mailer,
        appUrl: cfg.mailer.appUrl,
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
      notifications: notificationService,
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
  {
    userbotRegistry.setRunnerFactory((entry, signal) =>
      startUserbotInboundRunner({
        entry,
        db,
        signal,
        replyStrategy: replyStrategy ?? null,
        resolveTemplate,
        memoryExtractor,
        stageClassifier,
        notifications: notificationService,
        photoProcessor,
        fieldExtractor,
        sink,
        metrics,
        log,
        ...(resolveTranscriber ? { resolveTranscriber } : {}),
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
    log.info("channel-userbot enabled (per-tenant MTProto creds)", {
      connected: userbotRegistry.size(),
      envFallback: userbotEnvFallback,
    });
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
    // idleTimeout: 0 — отключаем закрытие idle-соединений.
    // По умолчанию Bun закрывает idle TCP через 10 с, что рвёт SSE-стримы
    // (GET /api/admin/events) до первого пинга.
    idleTimeout: 0,
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
    clearInterval(usageAlertInterval);
    clearTimeout(usageAlertFirstRun);
    if (rateFeedInterval) clearInterval(rateFeedInterval);
    if (dripDispatchInterval) clearInterval(dripDispatchInterval);
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
  // Usage alerts — проверяем каждый час все активные тенанты.
  // Отправляет email при 80% / 100% LLM-квоты (дедупликация in-memory по месяцу).
  const usageAlertInterval = setInterval(
    () => {
      checkUsageAlerts(db as never, mailer, cfg.mailer.appUrl).catch((e) =>
        log.warn("usage-alerts check failed", { err: e }),
      );
    },
    60 * 60 * 1000,
  ); // каждый час
  // Первый запуск через 5 минут после старта (не сразу — дать DB прогреться).
  const usageAlertFirstRun = setTimeout(
    () => {
      checkUsageAlerts(db as never, mailer, cfg.mailer.appUrl).catch((e) =>
        log.warn("usage-alerts initial check failed", { err: e }),
      );
    },
    5 * 60 * 1000,
  );

  // Exchange rate-feed: тик-планировщик с per-tenant частотой (exchange_settings).
  // RATE_FEED_MS (default 180000 = 3 мин) — дефолт per-tenant; 0 — отключить.
  // Тик = min(RATE_FEED_MS, 60с): на каждом тике рефрешим тенантов, у кого подошёл
  // их интервал. last-refresh держим в памяти (на рестарте рефрешим всех).
  const rateFeedMs = Number.parseInt(process.env.RATE_FEED_MS ?? "180000", 10);
  let rateFeedInterval: ReturnType<typeof setInterval> | null = null;
  let dripDispatchInterval: ReturnType<typeof setInterval> | null = null;
  if (rateFeedMs > 0) {
    const defaultRefreshSec = Math.max(60, Math.floor(rateFeedMs / 1000));
    const tickMs = Math.min(rateFeedMs, 60_000);
    const lastRefreshByTenant = new Map<number, number>();
    const runFeed = () =>
      refreshDueTenants(db, {
        defaultRefreshSec,
        lastRefreshByTenant,
        nowSec: Math.floor(Date.now() / 1000),
        log: {
          warn: (m) => log.warn(m),
          info: (m) => log.info(m),
        },
        // Резкое колебание курса (sanity-guard отклонил фид) → алерт владельцу.
        onAnomaly: (a) => {
          const dev = Number.isFinite(a.deviationPct) ? Math.round(a.deviationPct) : null;
          log.warn("rate-feed anomaly: резкое колебание курса", {
            tenantId: a.tenantId,
            asset: a.asset,
            prev: a.prev,
            next: a.next,
            deviationPct: dev,
          });
          void opsAlertRouter
            .emit({
              tenantId: a.tenantId,
              kind: "rate_anomaly",
              severity: "critical",
              title: "Резкое колебание курса",
              detail:
                `Фид по ${a.asset} дал ${a.next} при текущем ${a.prev}` +
                `${dev !== null ? ` (${dev > 0 ? "+" : ""}${dev}%)` : ""} — отклонено sanity-guard'ом. ` +
                "Курс заморожен на прежнем значении, бот может котировать устаревший курс. Проверьте фид/курс.",
              dedupKey: `rate_anomaly:${a.asset}`,
            })
            .catch((e) => log.warn("ops-alert emit failed", { err: String(e) }));
        },
      }).catch((e) => log.warn("rate-feed tick failed", { err: e }));
    rateFeedInterval = setInterval(runFeed, tickMs);
    setTimeout(runFeed, 15_000); // первый прогон через 15с после старта
    log.info("exchange rate-feed enabled (per-tenant)", { defaultRefreshSec, tickMs });
  }

  // Дрип-диспетчер кампаний: «капает» лидов в outbound_queue с заданной скоростью.
  // DRIP_DISPATCH_MS=0 отключает. Тик частый (10с), сама скорость — в кампании.
  const dripDispatchMs = Number.parseInt(process.env.DRIP_DISPATCH_MS ?? "10000", 10);
  if (dripDispatchMs > 0) {
    const runDrip = () =>
      dripDispatchTick(db, {
        nowSec: Math.floor(Date.now() / 1000),
        log: { warn: (m) => log.warn(m), info: (m) => log.info(m) },
      }).catch((e) =>
        log.warn("drip-dispatcher tick failed", {
          err: e instanceof Error ? e.message : String(e),
        }),
      );
    dripDispatchInterval = setInterval(runDrip, dripDispatchMs);
    setTimeout(runDrip, 12_000);
    log.info("outreach drip-dispatcher enabled", { dripDispatchMs });
  }

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
