/**
 * shadowDecide() unit tests.
 *
 * The full runShadowEval() path is integration-only (it spawns LLM calls
 * + writes to the DB through multiple repos). What we lock down here is
 * the decision boundary: Wilson 95% lower bound thresholds at 0.55 / 0.45.
 * Off-by-one in the threshold logic would silently keep regressions or
 * roll back wins, so this is the most important contract to test.
 */
import { describe, expect, test } from "bun:test";

import { shadowDecide } from "@/sales/shadow-eval.ts";

describe("shadowDecide", () => {
  test("zero pairs → inconclusive", () => {
    expect(shadowDecide(0, 0)).toBe("inconclusive");
  });

  test("clear B-win batch → keep", () => {
    // 18/20 wins → Wilson LB ~0.74, well above 0.55
    expect(shadowDecide(18, 20)).toBe("keep");
  });

  test("clear B-loss batch → rollback", () => {
    // 2/20 wins → Wilson LB ~0.026, well below 0.45
    expect(shadowDecide(2, 20)).toBe("rollback");
  });

  test("50/50 with small sample → rollback (Wilson is conservative)", () => {
    // 5/10 → Wilson LB ~0.237, BELOW 0.45 → rollback. Demonstrates why
    // a 50/50 result on a tiny sample doesn't keep the new version:
    // there's not enough evidence that B isn't actually worse.
    expect(shadowDecide(5, 10)).toBe("rollback");
  });

  test("borderline case at sample=20", () => {
    // 12/20 → Wilson LB ~0.39, below 0.45 → rollback
    expect(shadowDecide(12, 20)).toBe("rollback");
  });

  test("draws contribute as half-wins", () => {
    // 10 wins + 10 draws (= 15 adjusted) over 20 pairs
    // Wilson LB ~0.53, between thresholds → inconclusive
    expect(shadowDecide(15, 20)).toBe("inconclusive");
  });

  test("strong batch with draws → keep", () => {
    // 30 adjusted over 40 → Wilson LB ~0.60 → keep
    expect(shadowDecide(30, 40)).toBe("keep");
  });
});
