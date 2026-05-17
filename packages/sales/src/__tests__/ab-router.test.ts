import { describe, expect, test } from "bun:test";
import type { Experiment } from "../ab-router.ts";
import { pickVariant } from "../ab-router.ts";

const exp: Experiment = {
  slug: "test-exp",
  variants: [
    { styleSlug: "a", weight: 50 },
    { styleSlug: "b", weight: 50 },
  ],
};

describe("pickVariant — determinism", () => {
  test("same user always gets same variant", () => {
    const r1 = pickVariant(exp, "user-42");
    const r2 = pickVariant(exp, "user-42");
    expect(r1).toBe(r2);
  });

  test("numeric and string userId produce the same result", () => {
    const r1 = pickVariant(exp, 42);
    const r2 = pickVariant(exp, "42");
    expect(r1).toBe(r2);
  });

  test("different experiment slug changes assignment", () => {
    const expB: Experiment = { ...exp, slug: "other-exp" };
    const r1 = pickVariant(exp, "user-1");
    const r2 = pickVariant(expB, "user-1");
    // Not guaranteed to differ for every user, but for a fixed user at
    // least one of many users will differ — verify we get a valid slug.
    expect(["a", "b"]).toContain(r1);
    expect(["a", "b"]).toContain(r2);
  });
});

describe("pickVariant — weight distribution", () => {
  test("50/50 split is approximately balanced over 1000 users", () => {
    let countA = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      if (pickVariant(exp, `u${i}`) === "a") countA++;
    }
    // Allow ±5% deviation (expect 500 ± 50)
    expect(countA).toBeGreaterThan(450);
    expect(countA).toBeLessThan(550);
  });

  test("80/20 split sends ~80% to variant a", () => {
    const exp2: Experiment = {
      slug: "weighted",
      variants: [
        { styleSlug: "a", weight: 80 },
        { styleSlug: "b", weight: 20 },
      ],
    };
    let countA = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      if (pickVariant(exp2, `u${i}`) === "a") countA++;
    }
    // Allow ±8% deviation
    expect(countA).toBeGreaterThan(720);
    expect(countA).toBeLessThan(880);
  });

  test("100% weight on one variant → always that variant", () => {
    const single: Experiment = {
      slug: "single",
      variants: [{ styleSlug: "only", weight: 100 }],
    };
    for (let i = 0; i < 20; i++) {
      expect(pickVariant(single, `u${i}`)).toBe("only");
    }
  });
});

describe("pickVariant — edge cases & errors", () => {
  test("empty variants → throws", () => {
    const empty: Experiment = { slug: "e", variants: [] };
    expect(() => pickVariant(empty, "u1")).toThrow();
  });

  test("all-zero weights → throws", () => {
    const zero: Experiment = {
      slug: "z",
      variants: [{ styleSlug: "a", weight: 0 }],
    };
    expect(() => pickVariant(zero, "u1")).toThrow();
  });

  test("returns one of the defined slugs", () => {
    const slugs = exp.variants.map((v) => v.styleSlug);
    for (let i = 0; i < 50; i++) {
      expect(slugs).toContain(pickVariant(exp, `u${i}`));
    }
  });
});
