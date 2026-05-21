import type { VerticalTemplate } from "@chatman-media/verticals";
import { RECRUITMENT_UAE_V1 } from "@chatman-media/vertical-recruitment-uae";
import { Hono } from "hono";
import { ChannelRegistry } from "./channel-registry.ts";
import { loadApiConfig } from "./config.ts";
import { makeDb } from "./db.ts";
import {
  makeMemoryExtractor,
  makeReplyStrategy,
  makeStageClassifier,
} from "./llm-bootstrap.ts";
import { makeHealthRoutes } from "./routes/health.ts";
import { makeTelegramWebhookRoutes } from "./routes/webhook-telegram.ts";

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
  const { db, close } = makeDb(cfg.databaseUrl);

  const channels = new ChannelRegistry();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
  await channels.loadFromDb(db as any);

  const app = new Hono();

  app.route(
    "/",
    makeHealthRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
      db: db as any,
      timeoutMs: cfg.healthCheckTimeoutMs,
    }),
  );
  const replyStrategy = makeReplyStrategy(cfg, db);
  if (replyStrategy) {
    const strategyKind = cfg.embed.provider && cfg.embed.apiKey ? "RAG" : "LLM-only";
    console.log(
      `[apps/api] reply strategy: ${strategyKind} (chat=${cfg.llm.provider}/${cfg.llm.model}${
        cfg.embed.provider ? `, embed=${cfg.embed.provider}/${cfg.embed.model}` : ""
      }${cfg.defaultStyleSlug ? `, style=${cfg.defaultStyleSlug}` : ""})`,
    );
  } else {
    console.log("[apps/api] LLM not configured — bot will persist messages but stay silent");
  }

  const memoryExtractor = makeMemoryExtractor(cfg, db);
  if (memoryExtractor) {
    console.log("[apps/api] memory extractor enabled");
  }

  const stageClassifier = makeStageClassifier(cfg, db);
  if (stageClassifier) {
    console.log(`[apps/api] stage classifier enabled: ${cfg.stageClassifier}`);
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
    }),
  );

  const server = Bun.serve({
    port: cfg.port,
    fetch: app.fetch,
  });

  console.log(`[apps/api] listening on http://localhost:${server.port}`);

  // Graceful shutdown: дренируем channels, закрываем DB-пул.
  const shutdown = async () => {
    console.log("[apps/api] shutting down");
    server.stop();
    channels.closeAll();
    await close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  console.error("[apps/api] fatal", err);
  process.exit(1);
});
