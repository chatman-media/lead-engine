import { describe, expect, test } from "bun:test";

import { clientIp, RateLimiter } from "@/rate-limit.ts";

describe("RateLimiter.check", () => {
  test("allows a burst up to capacity, then rejects", () => {
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(false);
  });

  test("refills tokens as time elapses", () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(false);
    // 1s later → exactly one token refilled.
    expect(rl.check("a", 1000)).toBe(true);
    expect(rl.check("a", 1000)).toBe(false);
  });

  test("refill is capped at capacity (no overflow after long idle)", () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 });
    rl.check("a", 0);
    rl.check("a", 0);
    // 1000s idle would refill 1000 tokens — must clamp to capacity 2.
    expect(rl.check("a", 1_000_000)).toBe(true);
    expect(rl.check("a", 1_000_000)).toBe(true);
    expect(rl.check("a", 1_000_000)).toBe(false);
  });

  test("buckets are independent per key", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(false);
    expect(rl.check("b", 0)).toBe(true);
  });

  test("evicts the oldest bucket once maxEntries is exceeded", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1, maxEntries: 2 });
    expect(rl.check("a", 0)).toBe(true); // a: 1→0
    expect(rl.check("a", 0)).toBe(false); // a exhausted
    rl.check("b", 0); // map now {a, b}
    rl.check("c", 0); // inserting c evicts oldest (a) → map {b, c}
    // "a" was evicted, so it gets a fresh full bucket and is allowed again.
    expect(rl.check("a", 0)).toBe(true);
  });

  test("__resetForTesting drops all buckets", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    rl.check("a", 0);
    expect(rl.check("a", 0)).toBe(false);
    rl.__resetForTesting();
    expect(rl.check("a", 0)).toBe(true);
  });
});

describe("clientIp", () => {
  const reqWith = (headers: Record<string, string>) =>
    new Request("https://example.com/", { headers });

  test("uses the first entry of x-forwarded-for", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
  });

  test("falls back to x-real-ip", () => {
    expect(clientIp(reqWith({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  test("falls back to cf-connecting-ip", () => {
    expect(clientIp(reqWith({ "cf-connecting-ip": "8.8.8.8" }))).toBe("8.8.8.8");
  });

  test("returns 'unknown' when no proxy header is present", () => {
    expect(clientIp(reqWith({}))).toBe("unknown");
  });

  test("prefers x-forwarded-for over the other headers", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }))).toBe(
      "1.1.1.1",
    );
  });
});
