import { describe, expect, it } from "bun:test";
import { allPlans, resolvePlan } from "./plans.ts";

describe("plans", () => {
  it("resolvePlan known kinds", () => {
    expect(resolvePlan("free").label).toBe("Free");
    expect(resolvePlan("starter").label).toBe("Starter");
    expect(resolvePlan("pro").label).toBe("Pro");
    expect(resolvePlan("enterprise").label).toBe("Enterprise");
  });

  it("resolvePlan unknown → free fallback + onUnknown called", () => {
    const seen: string[] = [];
    const p = resolvePlan("legacy_bogus", (s) => seen.push(s));
    expect(p.label).toBe("Free");
    expect(seen).toEqual(["legacy_bogus"]);
  });

  it("plan tiers escalate maxChannels and rate limits", () => {
    expect(resolvePlan("free").maxChannels).toBeLessThan(resolvePlan("starter").maxChannels);
    expect(resolvePlan("starter").maxChannels).toBeLessThan(resolvePlan("pro").maxChannels);
    expect(resolvePlan("free").rateLimitPerMinute).toBeLessThan(
      resolvePlan("pro").rateLimitPerMinute,
    );
  });

  it("allPlans → returns 4 tiers", () => {
    const list = allPlans();
    expect(list).toHaveLength(4);
    expect(list.map((p) => p.kind).sort()).toEqual(["enterprise", "free", "pro", "starter"]);
  });

  it("free plan zero price, enterprise null price", () => {
    expect(resolvePlan("free").priceUsd).toBe(0);
    expect(resolvePlan("enterprise").priceUsd).toBeNull();
    // Phase 1 pricing pivot — was $49/$149, now $99/$199 для recruitment ARPU.
    expect(resolvePlan("starter").priceUsd).toBe(99);
    expect(resolvePlan("pro").priceUsd).toBe(199);
  });
});
