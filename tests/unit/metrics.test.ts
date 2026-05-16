import { beforeEach, describe, expect, test } from "bun:test";

import { __resetForTesting, inc, registerCounter, renderPrometheus } from "@/metrics.ts";

beforeEach(() => {
  __resetForTesting();
});

describe("inc", () => {
  test("creates an unknown counter on first use and accumulates", () => {
    inc("custom_total");
    inc("custom_total", 4);
    expect(renderPrometheus()).toContain("custom_total 5");
  });

  test("default increment is 1", () => {
    inc("hits_total");
    inc("hits_total");
    expect(renderPrometheus()).toContain("hits_total 2");
  });

  test("tracks independent series per label set", () => {
    inc("reqs_total", 1, { method: "GET" });
    inc("reqs_total", 2, { method: "POST" });
    inc("reqs_total", 1, { method: "GET" });
    const out = renderPrometheus();
    expect(out).toContain('reqs_total{method="GET"} 2');
    expect(out).toContain('reqs_total{method="POST"} 2');
  });

  test("label order is normalised so key order does not split a series", () => {
    inc("e_total", 1, { a: "1", b: "2" });
    inc("e_total", 1, { b: "2", a: "1" });
    const out = renderPrometheus();
    expect(out).toContain('e_total{a="1",b="2"} 2');
  });
});

describe("renderPrometheus", () => {
  test("emits HELP and TYPE lines for each counter", () => {
    registerCounter("widgets_total", "number of widgets");
    const out = renderPrometheus();
    expect(out).toContain("# HELP widgets_total number of widgets");
    expect(out).toContain("# TYPE widgets_total counter");
  });

  test("a registered counter with no events renders as 0", () => {
    registerCounter("idle_total", "never incremented");
    expect(renderPrometheus()).toContain("idle_total 0");
  });

  test("escapes quotes, backslashes and newlines in label values", () => {
    inc("weird_total", 1, { path: 'a"b\\c\nd' });
    expect(renderPrometheus()).toContain('weird_total{path="a\\"b\\\\c\\nd"} 1');
  });

  test("pre-registered well-known counters are present after reset", () => {
    const out = renderPrometheus();
    expect(out).toContain("tg_messages_total");
    expect(out).toContain("lead_transitions_total");
  });
});

describe("registerCounter", () => {
  test("is idempotent — re-registering does not wipe an existing series", () => {
    inc("keep_total", 3);
    registerCounter("keep_total", "help text");
    expect(renderPrometheus()).toContain("keep_total 3");
  });
});
