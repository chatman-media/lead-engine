import { describe, expect, it } from "bun:test";
import { Counter, Histogram, MetricsRegistry } from "./metrics.ts";

describe("Counter", () => {
  it("суммирует inc'и без labels", () => {
    const c = new Counter("foo_total", "test");
    c.inc();
    c.inc(2);
    c.inc(0.5);
    expect(c.format()).toContain("foo_total 3.5");
  });

  it("трекает отдельные значения per label combination", () => {
    const c = new Counter("hits_total", "by status");
    c.inc(1, { status: "ok" });
    c.inc(2, { status: "ok" });
    c.inc(1, { status: "error" });
    const out = c.format();
    expect(out).toContain('hits_total{status="ok"} 3');
    expect(out).toContain('hits_total{status="error"} 1');
  });

  it("labels рендерятся в алфавитном порядке (stable text-output)", () => {
    const c = new Counter("hits_total", "");
    c.inc(1, { z: "1", a: "2" });
    expect(c.format()).toContain('hits_total{a="2",z="1"} 1');
  });

  it('эскейпит \\ и " в label values', () => {
    const c = new Counter("hits_total", "");
    c.inc(1, { path: 'a"b\\c' });
    expect(c.format()).toContain('path="a\\"b\\\\c"');
  });

  it("HELP и TYPE — первые две строки", () => {
    const c = new Counter("foo_total", "доступные операции");
    const lines = c.format().split("\n");
    expect(lines[0]).toBe("# HELP foo_total доступные операции");
    expect(lines[1]).toBe("# TYPE foo_total counter");
  });
});

describe("Histogram", () => {
  it("bucket'ы должны быть строго возрастающими", () => {
    expect(() => new Histogram("h", "", [1, 1, 2])).toThrow(/ascending/);
    expect(() => new Histogram("h", "", [2, 1])).toThrow(/ascending/);
  });

  it("observe: cumulative bucket'ы + sum + count", () => {
    const h = new Histogram("lat_seconds", "latency", [0.1, 1, 10]);
    h.observe(0.05);
    h.observe(0.5);
    h.observe(5);
    h.observe(100); // в +Inf bucket
    const out = h.format();
    // 0.05 ≤ 0.1, 0.5 ≤ 1, 5 ≤ 10, 100 ≤ +Inf
    expect(out).toContain('lat_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('lat_seconds_bucket{le="1"} 2');
    expect(out).toContain('lat_seconds_bucket{le="10"} 3');
    expect(out).toContain('lat_seconds_bucket{le="+Inf"} 4');
    expect(out).toContain("lat_seconds_sum 105.55");
    expect(out).toContain("lat_seconds_count 4");
  });

  it("observe с labels — отдельные bucket'ы per label combination", () => {
    const h = new Histogram("lat_seconds", "", [1, 5]);
    h.observe(0.5, { route: "/a" });
    h.observe(0.5, { route: "/b" });
    h.observe(3, { route: "/a" });
    const out = h.format();
    expect(out).toContain('lat_seconds_bucket{le="1",route="/a"} 1');
    expect(out).toContain('lat_seconds_bucket{le="5",route="/a"} 2');
    expect(out).toContain('lat_seconds_bucket{le="1",route="/b"} 1');
  });

  it("reset() обнуляет bucketCounts/sums/counts (lines 81-83)", () => {
    const h = new Histogram("req_seconds", "", [0.5, 1]);
    h.observe(0.3);
    h.observe(0.7);
    expect(h.format()).toContain("req_seconds_count 2");
    h.reset();
    // после reset все счётчики чистые
    expect(h.format()).not.toContain("req_seconds_count 2");
  });
});

describe("MetricsRegistry", () => {
  it("format() склеивает все метрики двумя \\n", () => {
    const r = new MetricsRegistry();
    const c1 = r.register(new Counter("a_total", "first"));
    const c2 = r.register(new Counter("b_total", "second"));
    c1.inc();
    c2.inc(5);
    const out = r.format();
    expect(out).toContain("a_total 1");
    expect(out).toContain("b_total 5");
    // Метрики разделены пустой строкой.
    expect(out).toContain("a_total 1\n\n# HELP b_total");
  });

  it("reset() обнуляет все метрики", () => {
    const r = new MetricsRegistry();
    const c = r.register(new Counter("c_total", ""));
    c.inc(5);
    r.reset();
    expect(c.format()).not.toContain("c_total 5");
  });
});
