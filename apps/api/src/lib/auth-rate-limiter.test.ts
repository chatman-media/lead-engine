import { describe, expect, it } from "bun:test";
import { AuthRateLimiter, clientIpFromHeaders } from "./auth-rate-limiter.ts";

describe("AuthRateLimiter", () => {
  it("allows up to perMinute then blocks with Retry-After", () => {
    let t = 1_000_000;
    const rl = new AuthRateLimiter({ perMinute: 3, perHour: 100, now: () => t });
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(true);
    const blocked = rl.check("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("recovers after the minute window slides", () => {
    let t = 0;
    const rl = new AuthRateLimiter({ perMinute: 2, perHour: 100, now: () => t });
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(false);
    t += 61_000; // past the 60s window
    expect(rl.check("k").allowed).toBe(true);
  });

  it("enforces the hourly cap independently of keys", () => {
    let t = 0;
    const rl = new AuthRateLimiter({ perMinute: 100, perHour: 2, now: () => t });
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
    // Different key has its own bucket.
    expect(rl.check("b").allowed).toBe(true);
  });

  it("isolates buckets per key", () => {
    let t = 0;
    const rl = new AuthRateLimiter({ perMinute: 1, perHour: 100, now: () => t });
    expect(rl.check("ip:login:alice").allowed).toBe(true);
    expect(rl.check("ip:login:alice").allowed).toBe(false);
    expect(rl.check("ip:login:bob").allowed).toBe(true);
  });
});

describe("clientIpFromHeaders", () => {
  const mk = (h: Record<string, string>) => ({
    get: (n: string) => h[n.toLowerCase()] ?? null,
  });

  it("takes the first X-Forwarded-For hop", () => {
    expect(clientIpFromHeaders(mk({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
  });

  it("falls back to X-Real-IP", () => {
    expect(clientIpFromHeaders(mk({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("returns 'unknown' when no proxy header present", () => {
    expect(clientIpFromHeaders(mk({}))).toBe("unknown");
  });
});
