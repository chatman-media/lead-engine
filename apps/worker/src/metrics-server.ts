// Compact Prometheus exposition server для apps/worker. Не использует Hono
// (overhead) — просто Bun.serve с одним endpoint. Меньше зависимостей,
// меньше cold-start latency.

import type { PlatformMetrics } from "@chatman-media/observability";

export interface MetricsServer {
  port: number;
  stop(): void;
}

export function startMetricsServer(metrics: PlatformMetrics, port: number): MetricsServer {
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/metrics") {
        return new Response(metrics.registry.format(), {
          headers: { "content-type": "text/plain;version=0.0.4;charset=utf-8" },
        });
      }
      if (url.pathname === "/healthz") {
        return new Response("ok\n", { headers: { "content-type": "text/plain" } });
      }
      return new Response("not found\n", { status: 404 });
    },
  });
  return {
    port: server.port ?? port,
    stop: () => server.stop(),
  };
}
