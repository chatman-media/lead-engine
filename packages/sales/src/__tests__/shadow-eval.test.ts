import { describe, expect, test } from "bun:test";
import { shadowDecide } from "../shadow-eval.ts";

describe("shadowDecide", () => {
  test("0 pairs → inconclusive", () => {
    expect(shadowDecide(0, 0)).toBe("inconclusive");
  });

  test("all B wins → keep", () => {
    // Wilson LB of 10/10 is well above 0.55
    expect(shadowDecide(10, 10)).toBe("keep");
  });

  test("all A wins → rollback", () => {
    // Wilson LB of 0/10 is 0
    expect(shadowDecide(0, 10)).toBe("rollback");
  });

  test("50/50 with few samples → rollback (LB ~0.24 < 0.45)", () => {
    expect(shadowDecide(5, 10)).toBe("rollback");
  });

  test("8/10 B wins → inconclusive (LB ~0.49, between thresholds)", () => {
    // wilsonLB(8, 10) ≈ 0.49 — above rollback (0.45) but below keep (0.55)
    expect(shadowDecide(8, 10)).toBe("inconclusive");
  });

  test("50/50 with many samples still inconclusive", () => {
    // Wilson LB of 500/1000 ≈ 0.47 — below keep threshold (0.55)
    expect(shadowDecide(500, 1000)).toBe("inconclusive");
  });

  test("draws counted as 0.5 — mixed result with strong B lean → keep", () => {
    // 8 wins + 4 draws → bWinsAdjusted = 8 + 2 = 10 out of 12 total pairs
    // Wilson LB of 10/12 is well above 0.55
    expect(shadowDecide(10, 12)).toBe("keep");
  });

  test("Wilson LB boundary: just above keep threshold", () => {
    // We need LB >= 0.55. 90/100 gives LB ≈ 0.83 → keep
    expect(shadowDecide(90, 100)).toBe("keep");
  });

  test("Wilson LB boundary: just below rollback threshold", () => {
    // 5/100 gives LB ≈ 0.02 → rollback
    expect(shadowDecide(5, 100)).toBe("rollback");
  });
});
