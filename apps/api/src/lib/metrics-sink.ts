// PipelineSink-адаптер поверх PlatformMetrics из @chatman-media/observability.
// conversation-engine pipeline дёргает sink.emit(event) на каждом шаге —
// здесь мы конвертим события в counter.inc()/histogram.observe().
//
// Pipeline не зависит от observability'и: PipelineSink interface — это
// generic-hook (log + emit), apps/api инжектит конкретную имплементацию.

import type { PipelineEvent, PipelineSink } from "@chatman-media/conversation-engine";
import type { PlatformMetrics } from "@chatman-media/observability";

export function makeMetricsSink(metrics: PlatformMetrics): PipelineSink {
  return {
    emit(event: PipelineEvent): void {
      const tenantLabel = { tenant: String(event.tenantId) };
      switch (event.type) {
        case "inbound-received":
          metrics.inboundProcessed.inc(1, tenantLabel);
          break;
        case "message-persisted":
          // role label — user/assistant/human; нужен для split'а на
          // inbound vs reply persistence.
          metrics.inboundPersisted.inc(1, { ...tenantLabel, role: event.role });
          break;
        case "outbound-enqueued":
          metrics.outboundEnqueued.inc(1, tenantLabel);
          break;
        case "conversation-escalated":
          // Без отдельного counter'а пока (новый event тип). Падать
          // не нужно — log сам.
          break;
      }
    },
  };
}
