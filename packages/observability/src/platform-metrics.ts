import { Counter, Histogram, MetricsRegistry } from "./metrics.ts";

/**
 * Стандартный набор метрик платформы lead-engine. apps/api и apps/worker
 * создают одну инстанцию makePlatformMetrics() на boot и инжектят в
 * pipeline (через PipelineSink) + exposition в /metrics endpoint.
 */
export interface PlatformMetrics {
  registry: MetricsRegistry;
  // ── Webhook layer ──────────────────────────────────────────────────────
  webhookRequests: Counter;
  webhookLatency: Histogram;
  // ── Conversation pipeline ──────────────────────────────────────────────
  inboundProcessed: Counter;
  inboundPersisted: Counter;
  inboundDeduped: Counter;
  outboundEnqueued: Counter;
  pipelineLatency: Histogram;
  // ── Outbound dispatcher ────────────────────────────────────────────────
  outboundSent: Counter;
  outboundFailed: Counter;
  outboundDispatchLatency: Histogram;
  stuckReleased: Counter;
  // ── Provider relay marketplace ────────────────────────────────────────
  providerOrdersCreated: Counter;
  providerRequests: Counter;
  providerResponses: Counter;
  providerTimeToQuote: Histogram;
  providerPaidOrders: Counter;
  providerCommissionEarned: Counter;
  providerFailures: Counter;
  // ── LLM ────────────────────────────────────────────────────────────────
  llmCalls: Counter;
  llmErrors: Counter;
}

export function makePlatformMetrics(): PlatformMetrics {
  const r = new MetricsRegistry();
  return {
    registry: r,
    webhookRequests: r.register(
      new Counter("lead_engine_webhook_requests_total", "Webhook requests received, by channel + status"),
    ),
    webhookLatency: r.register(
      new Histogram(
        "lead_engine_webhook_latency_seconds",
        "Webhook handler latency, end-to-end including processInbound",
        [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      ),
    ),
    inboundProcessed: r.register(
      new Counter("lead_engine_inbound_processed_total", "Inbound messages processed, by tenant"),
    ),
    inboundPersisted: r.register(
      new Counter("lead_engine_inbound_persisted_total", "Inbound messages persisted (not deduped)"),
    ),
    inboundDeduped: r.register(
      new Counter("lead_engine_inbound_deduped_total", "Inbound messages skipped due to dedup hit"),
    ),
    outboundEnqueued: r.register(
      new Counter("lead_engine_outbound_enqueued_total", "OutboundEnvelopes pushed into outbound_queue"),
    ),
    pipelineLatency: r.register(
      new Histogram(
        "lead_engine_pipeline_latency_seconds",
        "processInbound latency end-to-end",
        [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      ),
    ),
    outboundSent: r.register(
      new Counter("lead_engine_outbound_sent_total", "OutboundEnvelopes successfully sent to channel"),
    ),
    outboundFailed: r.register(
      new Counter("lead_engine_outbound_failed_total", "OutboundEnvelope sends failed (with retry counter)"),
    ),
    outboundDispatchLatency: r.register(
      new Histogram(
        "lead_engine_outbound_dispatch_latency_seconds",
        "Дельта между outbound_queue.created_at и фактической отправкой",
        [0.1, 0.5, 1, 5, 15, 60, 300],
      ),
    ),
    stuckReleased: r.register(
      new Counter("lead_engine_outbound_stuck_released_total", "Stuck processing rows revived to pending"),
    ),
    providerOrdersCreated: r.register(
      new Counter("lead_engine_provider_orders_created_total", "Provider relay service orders created"),
    ),
    providerRequests: r.register(
      new Counter("lead_engine_provider_requests_total", "Provider outreach requests sent, by channel"),
    ),
    providerResponses: r.register(
      new Counter("lead_engine_provider_responses_total", "Provider responses received, by outcome"),
    ),
    providerTimeToQuote: r.register(
      new Histogram(
        "lead_engine_provider_time_to_quote_seconds",
        "Seconds from provider outreach sent to quoted response",
        [30, 60, 120, 300, 600, 1800, 3600, 10800],
      ),
    ),
    providerPaidOrders: r.register(
      new Counter("lead_engine_provider_paid_orders_total", "Provider relay orders marked paid"),
    ),
    providerCommissionEarned: r.register(
      new Counter("lead_engine_provider_commission_earned_total", "Provider relay commission amount earned"),
    ),
    providerFailures: r.register(
      new Counter("lead_engine_provider_failures_total", "Provider relay failures, by channel and reason"),
    ),
    llmCalls: r.register(
      new Counter("lead_engine_llm_calls_total", "LLM API calls, by provider+purpose"),
    ),
    llmErrors: r.register(
      new Counter("lead_engine_llm_errors_total", "LLM API errors, by provider+purpose+kind"),
    ),
  };
}
