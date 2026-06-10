import {
  AdminInformer,
  checkRlsEnforcement,
  NotificationsRepo,
  NotificationService,
  OpsAlertRouter,
  ResendEmailSender,
} from "@chatman-media/conversation-engine";
import { makeDefaultLogger, makePlatformMetrics } from "@chatman-media/observability";
import { WorkerChannelRegistry } from "./channel-registry.ts";
import { loadWorkerConfig } from "./config.ts";
import { makeDb } from "./db.ts";
import { OutboundDispatcher } from "./dispatcher.ts";
import { type MetricsServer, startMetricsServer } from "./metrics-server.ts";
import { CheckinSweeper } from "./checkin-sweep.ts";
import { ExchangePaymentSweeper } from "./exchange-payment-sweep.ts";
import { InformerDigestSweeper } from "./informer-digest-sweep.ts";
import { OperationsWatchSweeper } from "./ops-watch-sweep.ts";
import { StaleleadSweeper } from "./stale-lead-sweep.ts";

async function main() {
  const cfg = loadWorkerConfig();
  const log = makeDefaultLogger("apps/worker");
  const metrics = makePlatformMetrics();
  const { db, close } = makeDb(cfg.databaseUrl);

  // См. apps/api/src/index.ts — тот же rationale: warning если worker
  // запущен под BYPASSRLS-role'ью, RLS как defense-in-depth не работает.
  const rlsCheck = await checkRlsEnforcement(db);
  if (!rlsCheck.isEnforced) {
    log.warn("RLS not enforced — connection role bypasses row-level security", {
      role: rlsCheck.role,
      isSuperuser: rlsCheck.isSuperuser,
      hasBypassRls: rlsCheck.hasBypassRls,
      remediation:
        "Use a NOSUPERUSER NOBYPASSRLS Postgres role for apps/worker connection. See migration 0004 comments.",
    });
  } else {
    log.info("RLS enforced", { role: rlsCheck.role });
  }

  const channels = new WorkerChannelRegistry();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic signature
  await channels.loadFromDb(db as any, {
    masterKeyHex: cfg.masterKeyHex,
    onWarn: (msg, ctx) => log.warn(`worker-channel-registry: ${msg}`, ctx),
  });

  const notificationsRepo = new NotificationsRepo(db as any);
  // Email-канал владельца (для critical-гарантии информера и ops-алертов).
  const ownerEmail = cfg.resendApiKey
    ? new ResendEmailSender(cfg.resendApiKey, cfg.fromEmail)
    : null;
  // Информер владельца: единый путь доставки (уровни + дайджест + лента).
  const adminInformer = new AdminInformer({
    db: db as never,
    botToken: cfg.operatorBotToken,
    appUrl: cfg.appUrl,
    email: ownerEmail,
    cooldownSec: cfg.opsAlertCooldownMin * 60,
    log: {
      warn: (m, ctx) => log.warn(m, ctx as Record<string, unknown>),
      info: (m, ctx) => log.info(m, ctx as Record<string, unknown>),
    },
  });
  const notifications = new NotificationService(
    notificationsRepo,
    cfg.operatorBotToken,
    cfg.appUrl,
    adminInformer,
  );
  if (cfg.operatorBotToken) {
    log.info("operator notification bot enabled");
  }

  const abort = new AbortController();
  const dispatcher = new OutboundDispatcher(db, channels, {
    pollMs: cfg.dispatcherPollMs,
    batchSize: cfg.dispatcherBatchSize,
    metrics,
    notifications,
    // Worker делает push-доставку: bot-API HTTP / WhatsApp Cloud / VK.
    // Web и telegram_userbot держат pinned-соединение (WS / MTProto) в
    // apps/api — у них отдельные in-process dispatcher'ы (web-dispatcher.ts /
    // userbot-dispatcher.ts), которые claim'ят kind='web' / 'telegram_userbot'.
    // Если не отфильтровать — worker grab'нет такую row первым, не найдёт
    // адаптер, mark'нет fail.
    claimKinds: ["telegram_bot", "whatsapp", "facebook", "vk", "max"],
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

  // Stale-lead sweep: закрывает лиды, просроченные по stale_timeout_days.
  let staleSweeperPromise: Promise<void> = Promise.resolve();
  if (cfg.staleSweepIntervalMs > 0) {
    const sweeper = new StaleleadSweeper(db, {
      intervalMs: cfg.staleSweepIntervalMs,
      notifications,
    });
    staleSweeperPromise = sweeper.run(abort.signal).catch((err) => {
      log.error("stale-sweep fatal", { err: err instanceof Error ? err : new Error(String(err)) });
    });
    log.info("stale-lead sweep enabled", { intervalMs: cfg.staleSweepIntervalMs });
  }

  // Check-in sweep: проактивный пинг лидам без активности дольше checkin_interval_days.
  let checkinSweeperPromise: Promise<void> = Promise.resolve();
  if (cfg.checkinSweepIntervalMs > 0) {
    const checkinSweeper = new CheckinSweeper(db, { intervalMs: cfg.checkinSweepIntervalMs });
    checkinSweeperPromise = checkinSweeper.run(abort.signal).catch((err) => {
      log.error("checkin-sweep fatal", { err: err instanceof Error ? err : new Error(String(err)) });
    });
    log.info("check-in sweep enabled", { intervalMs: cfg.checkinSweepIntervalMs });
  }

  // Exchange payment-TTL sweep: напоминает/expire'ит заявки с истёкшим TTL котировки.
  let exchangePaymentSweeperPromise: Promise<void> = Promise.resolve();
  if (cfg.exchangePaymentSweepMs > 0) {
    const exchangeSweeper = new ExchangePaymentSweeper(db, {
      intervalMs: cfg.exchangePaymentSweepMs,
    });
    exchangePaymentSweeperPromise = exchangeSweeper.run(abort.signal).catch((err) => {
      log.error("exchange-payment-sweep fatal", {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    });
    log.info("exchange payment-TTL sweep enabled", { intervalMs: cfg.exchangePaymentSweepMs });
  }

  // Operations-watcher: следит за здоровьем обменника (устаревание курсов,
  // зависшие заявки, упавшие каналы, всплеск оборота).
  let opsWatchPromise: Promise<void> = Promise.resolve();
  if (cfg.opsWatchMs > 0) {
    // Severity-роутер: личный Telegram владельца + email (fallback/critical),
    // анти-шторм через cooldown. #145.
    const opsRouter = new OpsAlertRouter({
      db,
      botToken: cfg.operatorBotToken,
      appUrl: cfg.appUrl,
      email: ownerEmail,
      // Делегируем доставку информеру (уровни/дайджест/лента) — без дублей.
      informer: adminInformer,
      log: {
        warn: (m, ctx) => log.warn(m, ctx as Record<string, unknown>),
        info: (m, ctx) => log.info(m, ctx as Record<string, unknown>),
      },
    });
    const opsSweeper = new OperationsWatchSweeper(db, {
      intervalMs: cfg.opsWatchMs,
      sink: opsRouter,
      thresholds: {
        feedStaleMin: cfg.opsFeedStaleMin,
        stuckOrderMin: cfg.opsStuckOrderMin,
        volumeSpikeThb: cfg.opsVolumeSpikeThb,
        alertCooldownMin: cfg.opsAlertCooldownMin,
      },
    });
    opsWatchPromise = opsSweeper.run(abort.signal).catch((err) => {
      log.error("ops-watch fatal", { err: err instanceof Error ? err : new Error(String(err)) });
    });
    log.info("operations-watcher enabled", {
      intervalMs: cfg.opsWatchMs,
      feedStaleMin: cfg.opsFeedStaleMin,
      stuckOrderMin: cfg.opsStuckOrderMin,
    });
  }

  // Informer-digest: периодическая сводка владельцу по накопленной ленте
  // (события, не ушедшие в реалтайм). Расписание — в operator_settings.
  let informerDigestPromise: Promise<void> = Promise.resolve();
  if (cfg.informerDigestMs > 0 && cfg.operatorBotToken) {
    const digestSweeper = new InformerDigestSweeper(db, {
      intervalMs: cfg.informerDigestMs,
      botToken: cfg.operatorBotToken,
    });
    informerDigestPromise = digestSweeper.run(abort.signal).catch((err) => {
      log.error("informer-digest fatal", {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    });
    log.info("informer-digest enabled", { intervalMs: cfg.informerDigestMs });
  }

  // Periodic channel reload — подхватывает newly-onboarded боты которые
  // tenant добавил через apps/api UI после worker boot. apps/api делает
  // in-process hot-reload, worker — отдельный процесс, polling.
  let reloadTimer: ReturnType<typeof setInterval> | null = null;
  if (cfg.channelReloadIntervalMs > 0) {
    reloadTimer = setInterval(async () => {
      try {
        const delta = await channels.reloadAll();
        if (delta.before !== delta.after) {
          log.info("worker channels reloaded", { ...delta });
        }
      } catch (err) {
        log.warn("worker channel reload failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }, cfg.channelReloadIntervalMs);
    log.info("channel reload poller enabled", {
      intervalMs: cfg.channelReloadIntervalMs,
    });
  }

  const shutdown = async () => {
    log.info("shutting down");
    if (reloadTimer) clearInterval(reloadTimer);
    abort.abort();
    dispatcher.stop();
    metricsServer?.stop();
    await Promise.all([
      dispatcherPromise,
      staleSweeperPromise,
      checkinSweeperPromise,
      exchangePaymentSweeperPromise,
      opsWatchPromise,
      informerDigestPromise,
    ]);
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
