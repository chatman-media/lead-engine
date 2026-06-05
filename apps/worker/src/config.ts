export interface WorkerConfig {
  databaseUrl: string;
  masterKeyHex: string;
  /** Period polling outbound_queue, ms. По умолчанию 1000 (раз в секунду). */
  dispatcherPollMs: number;
  /** Сколько envelope'ов брать за один pop. */
  dispatcherBatchSize: number;
  /** На сколько разрешено отстать от scheduled_at (для testов/replay). */
  dispatcherMaxLagSec: number;
  /**
   * Port для /metrics endpoint'а (Prometheus scraper). Если не задан — 0 —
   * worker НЕ поднимает HTTP-сервер, метрики недоступны извне. Recommended:
   * 9100 (Prometheus exporter port standard).
   */
  metricsPort: number;
  /**
   * Период polling-based reload channels из БД, ms. apps/api делает
   * hot-reload in-process, но worker — отдельный процесс, ему нужно
   * периодически опрашивать channels из БД чтобы подхватить newly-onboarded
   * боты. Default 30000 (30 сек). 0 — отключить (только при boot).
   */
  channelReloadIntervalMs: number;
  /**
   * Период stale-lead sweep, ms. Default 3600000 (раз в час). 0 — отключить.
   * Sweep закрывает лиды, зависшие на стадии дольше stale_timeout_days.
   */
  staleSweepIntervalMs: number;
  /**
   * Период check-in sweep, ms. Default 3600000 (раз в час). 0 — отключить.
   * Sweep отправляет проактивный пинг лидам, у которых нет активности
   * дольше stage_definitions.checkin_interval_days.
   */
  checkinSweepIntervalMs: number;
  /**
   * Период payment-TTL sweep обменника, ms. Default 60000 (раз в минуту). 0 — отключить.
   * Напоминает/expire'ит заявки exchange_orders с истёкшим TTL котировки.
   */
  exchangePaymentSweepMs: number;
  /**
   * Период operations-watcher (#144), ms. Default 300000 (5 мин). 0 — отключить.
   * Проверяет здоровье обменника: устаревание курсов, зависшие заявки,
   * упавшие каналы, всплеск оборота.
   */
  opsWatchMs: number;
  /** Курс auto-строк не обновлялся дольше N минут → алерт. Default 20. */
  opsFeedStaleMin: number;
  /** Заявка в paid/payout дольше N минут → алерт. Default 45. */
  opsStuckOrderMin: number;
  /** Оборот за час выше N THB → алерт. Default 0 (отключено). */
  opsVolumeSpikeThb: number;
  /** Не повторять алерт одного типа чаще N минут. Default 60. */
  opsAlertCooldownMin: number;
  /**
   * Период informer-digest-sweep (сводка владельцу по накопленной ленте), ms.
   * Default 900000 (15 мин — чтобы надёжно попадать в окно digest-часа).
   * 0 — отключить. env WORKER_INFORMER_DIGEST_MS.
   */
  informerDigestMs: number;
  /**
   * Платформенный токен для бота уведомлений операторов.
   * env PLATFORM_OPERATOR_BOT_TOKEN.
   */
  operatorBotToken: string;
  /**
   * Базовый URL админки для глубоких ссылок.
   * env PLATFORM_APP_URL.
   */
  appUrl: string;
  /** Resend API key для email-алертов владельцу (#145). Пусто → email отключён. */
  resendApiKey: string;
  /** From-адрес для email. env PLATFORM_FROM_EMAIL. */
  fromEmail: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`apps/worker config: missing env ${name}`);
  }
  return v;
}

export function loadWorkerConfig(): WorkerConfig {
  return {
    databaseUrl: required("DATABASE_URL"),
    masterKeyHex: required("PLATFORM_MASTER_KEY"),
    dispatcherPollMs: Number.parseInt(process.env.DISPATCHER_POLL_MS ?? "1000", 10),
    dispatcherBatchSize: Number.parseInt(process.env.DISPATCHER_BATCH_SIZE ?? "16", 10),
    dispatcherMaxLagSec: Number.parseInt(process.env.DISPATCHER_MAX_LAG_SEC ?? "60", 10),
    metricsPort: Number.parseInt(process.env.METRICS_PORT ?? "0", 10),
    channelReloadIntervalMs: Number.parseInt(
      process.env.WORKER_CHANNEL_RELOAD_MS ?? "30000",
      10,
    ),
    staleSweepIntervalMs: Number.parseInt(
      process.env.WORKER_STALE_SWEEP_MS ?? "3600000",
      10,
    ),
    checkinSweepIntervalMs: Number.parseInt(
      process.env.WORKER_CHECKIN_SWEEP_MS ?? "3600000",
      10,
    ),
    exchangePaymentSweepMs: Number.parseInt(
      process.env.WORKER_EXCHANGE_PAYMENT_SWEEP_MS ?? "60000",
      10,
    ),
    opsWatchMs: Number.parseInt(process.env.WORKER_OPS_WATCH_MS ?? "300000", 10),
    opsFeedStaleMin: Number.parseInt(process.env.OPS_FEED_STALE_MIN ?? "20", 10),
    opsStuckOrderMin: Number.parseInt(process.env.OPS_STUCK_ORDER_MIN ?? "45", 10),
    opsVolumeSpikeThb: Number.parseInt(process.env.OPS_VOLUME_SPIKE_THB ?? "0", 10),
    opsAlertCooldownMin: Number.parseInt(process.env.OPS_ALERT_COOLDOWN_MIN ?? "60", 10),
    informerDigestMs: Number.parseInt(process.env.WORKER_INFORMER_DIGEST_MS ?? "900000", 10),
    operatorBotToken: process.env.PLATFORM_OPERATOR_BOT_TOKEN ?? "",
    appUrl: process.env.PLATFORM_APP_URL ?? "https://app.leadengine.app",
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    fromEmail: process.env.PLATFORM_FROM_EMAIL ?? "lead-engine <noreply@leadengine.app>",
  };
}
