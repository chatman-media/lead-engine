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
  };
}
