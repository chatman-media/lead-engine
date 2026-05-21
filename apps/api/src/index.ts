import { makeDefaultLogger, makePlatformMetrics } from "@chatman-media/observability";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { RECRUITMENT_UAE_V1 } from "@chatman-media/vertical-recruitment-uae";
import { Hono } from "hono";
import { ChannelRegistry } from "./channel-registry.ts";
import { loadApiConfig } from "./config.ts";
import { makeDb } from "./db.ts";
import { makeMetricsSink } from "./lib/metrics-sink.ts";
import { WebChannelRegistry } from "./lib/web-channel-registry.ts";
import { WebOutboundDispatcher } from "./lib/web-dispatcher.ts";
import { startWebInboundRunner } from "./lib/web-inbound-runner.ts";
import {
  makeMemoryExtractor,
  makeReplyStrategy,
  makeStageClassifier,
} from "./llm-bootstrap.ts";
import { makeTenantContextMiddleware, requireTenant } from "./middleware/tenant-context.ts";
import { makeAdminRoutes } from "./routes/admin.ts";
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

  const channels = new ChannelRegistry();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
  await channels.loadFromDb(db as any);

  const app = new Hono();

  app.route("/", makeMetricsRoutes(metrics));

  app.route(
    "/",
    makeHealthRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
      db: db as any,
      timeoutMs: cfg.healthCheckTimeoutMs,
    }),
  );
  const replyStrategy = makeReplyStrategy(cfg, db, metrics);
  if (replyStrategy) {
    const strategyKind = cfg.embed.provider && cfg.embed.apiKey ? "RAG" : "LLM-only";
    log.info("reply strategy configured", {
      kind: strategyKind,
      chat: `${cfg.llm.provider}/${cfg.llm.model}`,
      ...(cfg.embed.provider
        ? { embed: `${cfg.embed.provider}/${cfg.embed.model}` }
        : {}),
      ...(cfg.defaultStyleSlug ? { style: cfg.defaultStyleSlug } : {}),
      ...(cfg.experimentSlug ? { experiment: cfg.experimentSlug } : {}),
    });
  } else {
    log.info("LLM not configured — bot will persist messages but stay silent");
  }

  const memoryExtractor = makeMemoryExtractor(cfg, db, metrics);
  if (memoryExtractor) log.info("memory extractor enabled");

  const stageClassifier = makeStageClassifier(cfg, db, metrics);
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
        replyStrategy,
        resolveTemplate,
        memoryExtractor,
        stageClassifier,
        sink,
        metrics,
      }),
    );
    log.info("whatsapp webhook enabled");
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
