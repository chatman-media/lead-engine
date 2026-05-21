import { Hono } from "hono";
import { ChannelRegistry } from "./channel-registry.ts";
import { loadApiConfig } from "./config.ts";
import { makeDb } from "./db.ts";
import { makeHealthRoutes } from "./routes/health.ts";
import { makeTelegramWebhookRoutes } from "./routes/webhook-telegram.ts";

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
  app.route(
    "/",
    makeTelegramWebhookRoutes({
      db,
      channels,
      webhookSecret: cfg.telegramWebhookSecret,
      // ReplyStrategy подключается в Этапе 4 часть 2 (RAG + sales).
      replyStrategy: null,
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
