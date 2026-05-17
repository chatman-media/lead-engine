import { describe, expect, test } from "bun:test";
import { type Experiment, pickVariant } from "../../../src/sales/ab-router.ts";

const TWO_WAY: Experiment = {
  slug: "test-exp",
  variants: [
    { styleSlug: "a", weight: 50 },
    { styleSlug: "b", weight: 50 },
  ],
};

const SKEWED: Experiment = {
  slug: "skewed",
  variants: [
    { styleSlug: "a", weight: 80 },
    { styleSlug: "b", weight: 20 },
  ],
};

describe("pickVariant — determinism", () => {
  test("same userId always returns same variant", () => {
    const userId = "user-42";
    const first = pickVariant(TWO_WAY, userId);
    for (let i = 0; i < 100; i++) {
      expect(pickVariant(TWO_WAY, userId)).toBe(first);
    }
  });

  test("string vs number userId — both stable", () => {
    const a = pickVariant(TWO_WAY, "12345");
    const b = pickVariant(TWO_WAY, 12345);
    // String "12345" and number 12345 hash the same since we stringify with template literal.
    expect(a).toBe(b);
  });

  test("different experiment slugs decorrelate users", () => {
    // For at least one userId, the two experiments should disagree.
    const expA: Experiment = { slug: "exp-a", variants: TWO_WAY.variants };
    const expB: Experiment = { slug: "exp-b", variants: TWO_WAY.variants };
    let disagreements = 0;
    for (let i = 0; i < 200; i++) {
      if (pickVariant(expA, `u${i}`) !== pickVariant(expB, `u${i}`)) disagreements += 1;
    }
    // Independent hashes should flip ~50% of the time. >20% is a sane lower bound.
    expect(disagreements).toBeGreaterThan(40);
  });
});

describe("pickVariant — distribution", () => {
  test("50/50 split is roughly balanced over 1000 users", () => {
    let aCount = 0;
    for (let i = 0; i < 1000; i++) {
      if (pickVariant(TWO_WAY, `u${i}`) === "a") aCount += 1;
    }
    // Tolerate ±10% drift from perfect 500/500.
    expect(aCount).toBeGreaterThan(400);
    expect(aCount).toBeLessThan(600);
  });

  test("80/20 skewed split honors the ratio", () => {
    let aCount = 0;
    for (let i = 0; i < 1000; i++) {
      if (pickVariant(SKEWED, `u${i}`) === "a") aCount += 1;
    }
    // Expect ~800 of 1000 to be variant "a". Tolerance ±100.
    expect(aCount).toBeGreaterThan(700);
    expect(aCount).toBeLessThan(900);
  });
});

describe("pickVariant — edge cases", () => {
  test("single variant always wins", () => {
    const exp: Experiment = {
      slug: "solo",
      variants: [{ styleSlug: "only", weight: 100 }],
    };
    for (let i = 0; i < 50; i++) {
      expect(pickVariant(exp, `u${i}`)).toBe("only");
    }
  });

  test("zero-weight variant is never chosen", () => {
    const exp: Experiment = {
      slug: "zero-weight",
      variants: [
        { styleSlug: "a", weight: 100 },
        { styleSlug: "b", weight: 0 },
      ],
    };
    for (let i = 0; i < 200; i++) {
      expect(pickVariant(exp, `u${i}`)).toBe("a");
    }
  });

  test("throws when no variants", () => {
    const exp: Experiment = { slug: "empty", variants: [] };
    expect(() => pickVariant(exp, "u1")).toThrow(/no variants/);
  });

  test("throws when total weight is zero", () => {
    const exp: Experiment = {
      slug: "bad-weights",
      variants: [
        { styleSlug: "a", weight: 0 },
        { styleSlug: "b", weight: 0 },
      ],
    };
    expect(() => pickVariant(exp, "u1")).toThrow(/total weight/);
  });

  test("non-equal but adding-to-100 weights work", () => {
    const exp: Experiment = {
      slug: "three-way",
      variants: [
        { styleSlug: "a", weight: 50 },
        { styleSlug: "b", weight: 30 },
        { styleSlug: "c", weight: 20 },
      ],
    };
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 1000; i++) {
      const v = pickVariant(exp, `u${i}`) as "a" | "b" | "c";
      counts[v] += 1;
    }
    expect(counts.a + counts.b + counts.c).toBe(1000);
    expect(counts.a).toBeGreaterThan(counts.b);
    expect(counts.b).toBeGreaterThan(counts.c);
  });
});
