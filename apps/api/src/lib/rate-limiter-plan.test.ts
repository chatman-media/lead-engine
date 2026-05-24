// Unit-tests for per-plan rate limit overrides in InboundRateLimiter.

import { describe, expect, it } from "bun:test";
import { InboundRateLimiter } from "./rate-limiter.ts";

describe("InboundRateLimiter — per-plan overrides", () => {
  it("uses global opts when no per-tenant limits are passed", () => {
    const limiter = new InboundRateLimiter({ perMinute: 2, perHour: 100 });
    expect(limiter.check(1).allowed).toBe(true); // 1st
    expect(limiter.check(1).allowed).toBe(true); // 2nd
    expect(limiter.check(1).allowed).toBe(false); // 3rd — over global limit
  });

  it("applies per-tenant plan limits when provided", () => {
    // Global limit: 100/min, Plan limit: 1/min → stricter plan wins (min of both)
    const limiter = new InboundRateLimiter({ perMinute: 100, perHour: 1000 });
    expect(limiter.check(1, { perMinute: 1, perHour: 100 }).allowed).toBe(true);
    const second = limiter.check(1, { perMinute: 1, perHour: 100 });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("per_minute");
  });

  it("global opts act as a hard cap: min(plan, global)", () => {
    // Global: 1/min, Plan: 100/min → global wins (min = 1)
    const limiter = new InboundRateLimiter({ perMinute: 1, perHour: 100 });
    expect(limiter.check(1, { perMinute: 100, perHour: 1000 }).allowed).toBe(true);
    expect(limiter.check(1, { perMinute: 100, perHour: 1000 }).allowed).toBe(false);
  });

  it("per-tenant limits are isolated between tenants", () => {
    const limiter = new InboundRateLimiter({ perMinute: 100, perHour: 1000 });
    // Tenant 1 hits their plan limit (1/min)
    limiter.check(1, { perMinute: 1, perHour: 100 });
    expect(limiter.check(1, { perMinute: 1, perHour: 100 }).allowed).toBe(false);
    // Tenant 2 is unaffected
    expect(limiter.check(2, { perMinute: 1, perHour: 100 }).allowed).toBe(true);
  });

  it("hour limit enforced via per-tenant override", () => {
    const limiter = new InboundRateLimiter({ perMinute: 1000, perHour: 1000 });
    expect(limiter.check(1, { perMinute: 100, perHour: 1 }).allowed).toBe(true);
    const second = limiter.check(1, { perMinute: 100, perHour: 1 });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("per_hour");
  });

  it("when global opts are 0 (disabled) plan limits apply exclusively", () => {
    const limiter = new InboundRateLimiter({ perMinute: 0, perHour: 0 });
    expect(limiter.check(1, { perMinute: 1, perHour: 100 }).allowed).toBe(true);
    expect(limiter.check(1, { perMinute: 1, perHour: 100 }).allowed).toBe(false);
  });
});
