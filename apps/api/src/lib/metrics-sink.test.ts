import { makePlatformMetrics } from "@chatman-media/observability";
import { describe, expect, it } from "bun:test";
import { makeMetricsSink } from "./metrics-sink.ts";

describe("metrics-sink", () => {
  it("inbound-received → inboundProcessed counter +1", () => {
    const metrics = makePlatformMetrics();
    const sink = makeMetricsSink(metrics);
    sink.emit?.({
      type: "inbound-received",
      tenantId: 7,
      conversationId: 100,
      // biome-ignore lint/suspicious/noExplicitAny: dummy Inbound shape
      inbound: {} as any,
    });
    const exposed = metrics.registry.format();
    expect(exposed).toContain('lead_engine_inbound_processed_total{tenant="7"} 1');
  });

  it("message-persisted → inboundPersisted с role label", () => {
    const metrics = makePlatformMetrics();
    const sink = makeMetricsSink(metrics);
    sink.emit?.({
      type: "message-persisted",
      tenantId: 7,
      conversationId: 100,
      messageId: 1,
      role: "user",
    });
    sink.emit?.({
      type: "message-persisted",
      tenantId: 7,
      conversationId: 100,
      messageId: 2,
      role: "assistant",
    });
    const exposed = metrics.registry.format();
    expect(exposed).toContain('lead_engine_inbound_persisted_total{role="user",tenant="7"} 1');
    expect(exposed).toContain('lead_engine_inbound_persisted_total{role="assistant",tenant="7"} 1');
  });

  it("outbound-enqueued → outboundEnqueued counter", () => {
    const metrics = makePlatformMetrics();
    const sink = makeMetricsSink(metrics);
    sink.emit?.({
      type: "outbound-enqueued",
      tenantId: 7,
      conversationId: 100,
      queueItemId: 42,
      // biome-ignore lint/suspicious/noExplicitAny: dummy envelope
      envelope: {} as any,
    });
    sink.emit?.({
      type: "outbound-enqueued",
      tenantId: 7,
      conversationId: 100,
      queueItemId: 43,
      // biome-ignore lint/suspicious/noExplicitAny: dummy envelope
      envelope: {} as any,
    });
    const exposed = metrics.registry.format();
    expect(exposed).toContain('lead_engine_outbound_enqueued_total{tenant="7"} 2');
  });

  it("conversation-escalated — без crash'а, нет counter'а пока", () => {
    const metrics = makePlatformMetrics();
    const sink = makeMetricsSink(metrics);
    expect(() =>
      sink.emit?.({
        type: "conversation-escalated",
        tenantId: 7,
        conversationId: 100,
        reason: "stale",
      }),
    ).not.toThrow();
  });

  it("много emit'ов на один tenant — counter аккумулируется", () => {
    const metrics = makePlatformMetrics();
    const sink = makeMetricsSink(metrics);
    for (let i = 0; i < 10; i++) {
      sink.emit?.({
        type: "inbound-received",
        tenantId: 7,
        conversationId: 100,
        // biome-ignore lint/suspicious/noExplicitAny: dummy Inbound
        inbound: {} as any,
      });
    }
    const exposed = metrics.registry.format();
    expect(exposed).toContain('lead_engine_inbound_processed_total{tenant="7"} 10');
  });

  it("разные tenant'ы — отдельные counter-series", () => {
    const metrics = makePlatformMetrics();
    const sink = makeMetricsSink(metrics);
    sink.emit?.({
      type: "inbound-received",
      tenantId: 1,
      conversationId: 100,
      // biome-ignore lint/suspicious/noExplicitAny: dummy Inbound
      inbound: {} as any,
    });
    sink.emit?.({
      type: "inbound-received",
      tenantId: 2,
      conversationId: 200,
      // biome-ignore lint/suspicious/noExplicitAny: dummy Inbound
      inbound: {} as any,
    });
    sink.emit?.({
      type: "inbound-received",
      tenantId: 2,
      conversationId: 200,
      // biome-ignore lint/suspicious/noExplicitAny: dummy Inbound
      inbound: {} as any,
    });
    const exposed = metrics.registry.format();
    expect(exposed).toContain('lead_engine_inbound_processed_total{tenant="1"} 1');
    expect(exposed).toContain('lead_engine_inbound_processed_total{tenant="2"} 2');
  });
});
