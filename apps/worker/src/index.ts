import { WorkerChannelRegistry } from "./channel-registry.ts";
import { loadWorkerConfig } from "./config.ts";
import { makeDb } from "./db.ts";
import { OutboundDispatcher } from "./dispatcher.ts";

async function main() {
  const cfg = loadWorkerConfig();
  const { db, close } = makeDb(cfg.databaseUrl);

  const channels = new WorkerChannelRegistry();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
  await channels.loadFromDb(db as any);

  const abort = new AbortController();
  const dispatcher = new OutboundDispatcher(db, channels, {
    pollMs: cfg.dispatcherPollMs,
    batchSize: cfg.dispatcherBatchSize,
  });

  console.log(
    `[apps/worker] starting; channels=${channels.size()}, ` +
      `dispatcher pollMs=${cfg.dispatcherPollMs} batchSize=${cfg.dispatcherBatchSize}`,
  );

  const dispatcherPromise = dispatcher.run(abort.signal).catch((err) => {
    console.error("[dispatcher] fatal", err);
  });

  const shutdown = async () => {
    console.log("[apps/worker] shutting down");
    abort.abort();
    dispatcher.stop();
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
  console.error("[apps/worker] fatal", err);
  process.exit(1);
});
