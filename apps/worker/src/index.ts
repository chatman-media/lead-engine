import { makeDefaultLogger, makePlatformMetrics } from "@chatman-media/observability";
import { WorkerChannelRegistry } from "./channel-registry.ts";
import { loadWorkerConfig } from "./config.ts";
import { makeDb } from "./db.ts";
import { OutboundDispatcher } from "./dispatcher.ts";
import { type MetricsServer, startMetricsServer } from "./metrics-server.ts";

async function main() {
  const cfg = loadWorkerConfig();
  const log = makeDefaultLogger("apps/worker");
  const metrics = makePlatformMetrics();
  const { db, close } = makeDb(cfg.databaseUrl);

  const channels = new WorkerChannelRegistry();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
  await channels.loadFromDb(db as any);

  const abort = new AbortController();
  const dispatcher = new OutboundDispatcher(db, channels, {
    pollMs: cfg.dispatcherPollMs,
    batchSize: cfg.dispatcherBatchSize,
    metrics,
  });

  let metricsServer: MetricsServer | null = null;
  if (cfg.metricsPort > 0) {
    metricsServer = startMetricsServer(metrics, cfg.metricsPort);
    log.info("metrics server enabled", {
      port: metricsServer.port,
      url: `http://localhost:${metricsServer.port}/metrics`,
    });
  }

  log.info("starting", {
    channels: channels.size(),
    pollMs: cfg.dispatcherPollMs,
    batchSize: cfg.dispatcherBatchSize,
  });

  const dispatcherPromise = dispatcher.run(abort.signal).catch((err) => {
    log.error("dispatcher fatal", { err: err instanceof Error ? err : new Error(String(err)) });
  });

  const shutdown = async () => {
    log.info("shutting down");
    abort.abort();
    dispatcher.stop();
    metricsServer?.stop();
    await dispatcherPromise;
    channels.closeAll();
    await close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await dispatcherPromise;
}

main().catch((err) => {
  const log = makeDefaultLogger("apps/worker");
  log.error("fatal", { err: err instanceof Error ? err : new Error(String(err)) });
  process.exit(1);
});
