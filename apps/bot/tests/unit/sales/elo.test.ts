import { describe, expect, test } from "bun:test";

import { actualScore, ELO_BASELINE, eloUpdate, eloUpdatePair, expectedScore } from "@/sales/elo.ts";

describe("ELO math", () => {
  test("actualScore maps outcomes to 0/0.5/1", () => {
    expect(actualScore("won")).toBe(1);
    expect(actualScore("draw")).toBe(0.5);
    expect(actualScore("lost")).toBe(0);
  });

  test("expectedScore is 0.5 for equal ratings", () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 6);
  });

  test("higher self → expected closer to 1", () => {
    expect(expectedScore(1700, 1500)).toBeGreaterThan(0.5);
    expect(expectedScore(1300, 1500)).toBeLessThan(0.5);
  });

  test("won outcome from baseline raises ELO", () => {
    const next = eloUpdate(ELO_BASELINE, "won");
    expect(next).toBeGreaterThan(ELO_BASELINE);
  });

  test("lost outcome from baseline lowers ELO", () => {
    const next = eloUpdate(ELO_BASELINE, "lost");
    expect(next).toBeLessThan(ELO_BASELINE);
  });

  test("draw at baseline is roughly neutral", () => {
    const next = eloUpdate(ELO_BASELINE, "draw");
    expect(Math.abs(next - ELO_BASELINE)).toBeLessThanOrEqual(1);
  });

  test("eloUpdatePair preserves zero-sum (delta_a = -delta_b)", () => {
    const a0 = 1600;
    const b0 = 1500;
    const { a, b } = eloUpdatePair(a0, b0, "won");
    // Allowing 1 unit drift due to integer rounding on each side independently.
    const delta = a - a0 + (b - b0);
    expect(Math.abs(delta)).toBeLessThanOrEqual(2);
  });

  test("custom K-factor scales the move proportionally", () => {
    const small = eloUpdate(ELO_BASELINE, "won", { k: 8 });
    const large = eloUpdate(ELO_BASELINE, "won", { k: 32 });
    expect(large - ELO_BASELINE).toBeGreaterThan(small - ELO_BASELINE);
  });
});
