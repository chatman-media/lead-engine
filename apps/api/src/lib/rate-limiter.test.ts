import { describe, expect, it } from "bun:test";
import { InboundRateLimiter } from "./rate-limiter.ts";

describe("InboundRateLimiter", () => {
  it("allows first N requests up to perMinute", () => {
    const lim = new InboundRateLimiter({ perMinute: 3, perHour: 100 });
    expect(lim.check(1).allowed).toBe(true);
    expect(lim.check(1).allowed).toBe(true);
    expect(lim.check(1).allowed).toBe(true);
    const fourth = lim.check(1);
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toBe("per_minute");
    expect(fourth.retryAfterSec).toBeGreaterThan(0);
    expect(fourth.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("per-tenant isolation: tenant 2 не упирается в лимит tenant'а 1", () => {
    const lim = new InboundRateLimiter({ perMinute: 1, perHour: 10 });
    expect(lim.check(1).allowed).toBe(true);
    expect(lim.check(1).allowed).toBe(false);
    // Tenant 2 имеет свой counter.
    expect(lim.check(2).allowed).toBe(true);
  });

  it("rejected check НЕ инкрементит counter (idempotent reject)", () => {
    const lim = new InboundRateLimiter({ perMinute: 2, perHour: 100 });
    lim.check(1);
    lim.check(1);
    const r1 = lim.check(1);
    const r2 = lim.check(1);
    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(false);
    // currentMinute остался на 2 (не вырос до 3, 4).
    expect(r1.currentMinute).toBe(2);
    expect(r2.currentMinute).toBe(2);
  });

  it("perHour лимит ловится после perMinute exhausted", () => {
    // perMinute=1000 чтобы не упереться в него, но perHour=2.
    const lim = new InboundRateLimiter({ perMinute: 1000, perHour: 2 });
    expect(lim.check(1).allowed).toBe(true);
    expect(lim.check(1).allowed).toBe(true);
    const third = lim.check(1);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe("per_hour");
  });

  it("stats() возвращает агрегат", () => {
    const lim = new InboundRateLimiter({ perMinute: 100, perHour: 1000 });
    lim.check(1);
    lim.check(1);
    lim.check(2);
    const s = lim.stats();
    expect(s.tenants).toBe(2);
    expect(s.totalTracked).toBe(3);
  });

  it("default config = 60/min, 600/hour", () => {
    const lim = new InboundRateLimiter();
    for (let i = 0; i < 60; i++) {
      expect(lim.check(1).allowed).toBe(true);
    }
    expect(lim.check(1).allowed).toBe(false);
  });
});
