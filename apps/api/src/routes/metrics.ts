import type { PlatformMetrics } from "@chatman-media/observability";
import { Hono } from "hono";

/**
 * GET /metrics — Prometheus exposition. Возвращает text/plain;version=0.0.4
 * (canonical Prometheus content-type). Endpoint должен быть доступен
 * Prometheus scraper'у, но НЕ из internet — обычно firewall'нется на
 * Fly internal-network'е или защищается basic-auth header'ом.
 */
export function makeMetricsRoutes(metrics: PlatformMetrics): Hono {
  const app = new Hono();
  app.get("/metrics", (c) => {
    return c.body(metrics.registry.format(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });
  return app;
}
