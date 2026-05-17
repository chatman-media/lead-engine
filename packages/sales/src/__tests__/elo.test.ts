import { describe, expect, test } from "bun:test";
import {
  actualScore,
  ELO_BASELINE,
  ELO_DEFAULT_K,
  eloUpdate,
  eloUpdatePair,
  expectedScore,
} from "../elo.ts";

describe("actualScore", () => {
  test("won → 1", () => expect(actualScore("won")).toBe(1));
  test("lost → 0", () => expect(actualScore("lost")).toBe(0));
  test("draw → 0.5", () => expect(actualScore("draw")).toBe(0.5));
});

describe("expectedScore", () => {
  test("equal ratings → 0.5", () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5);
  });

  test("higher self → > 0.5", () => {
    expect(expectedScore(1600, 1500)).toBeGreaterThan(0.5);
  });

  test("lower self → < 0.5", () => {
    expect(expectedScore(1400, 1500)).toBeLessThan(0.5);
  });

  test("400-point gap → ~0.91 / ~0.09", () => {
    expect(expectedScore(1900, 1500)).toBeCloseTo(0.909, 2);
    expect(expectedScore(1500, 1900)).toBeCloseTo(0.091, 2);
  });
});

describe("eloUpdate", () => {
  test("win against baseline raises rating", () => {
    const next = eloUpdate(ELO_BASELINE, "won");
    expect(next).toBeGreaterThan(ELO_BASELINE);
  });

  test("loss against baseline lowers rating", () => {
    const next = eloUpdate(ELO_BASELINE, "lost");
    expect(next).toBeLessThan(ELO_BASELINE);
  });

  test("draw against equal is neutral (rounds to same ± 1)", () => {
    const next = eloUpdate(ELO_BASELINE, "draw");
    expect(Math.abs(next - ELO_BASELINE)).toBeLessThanOrEqual(1);
  });

  test("win delta ≈ K * (1 - expected)", () => {
    const rating = 1500;
    const opp = 1500;
    const exp = expectedScore(rating, opp);
    const expected = Math.round(rating + ELO_DEFAULT_K * (1 - exp));
    expect(eloUpdate(rating, "won", { opponentRating: opp })).toBe(expected);
  });

  test("custom K factor is respected", () => {
    const a = eloUpdate(1500, "won", { k: 16 });
    const b = eloUpdate(1500, "won", { k: 32 });
    expect(b - 1500).toBeGreaterThan(a - 1500);
  });

  test("returns integer", () => {
    const n = eloUpdate(1500, "won");
    expect(Number.isInteger(n)).toBe(true);
  });
});

describe("eloUpdatePair", () => {
  test("winner gains, loser loses", () => {
    const { a, b } = eloUpdatePair(1500, 1500, "won");
    expect(a).toBeGreaterThan(1500);
    expect(b).toBeLessThan(1500);
  });

  test("sum is conserved", () => {
    const { a, b } = eloUpdatePair(1500, 1500, "won");
    expect(a + b).toBe(3000);
  });

  test("draw is near-neutral for equal ratings", () => {
    const { a, b } = eloUpdatePair(1500, 1500, "draw");
    expect(Math.abs(a - 1500)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - 1500)).toBeLessThanOrEqual(1);
  });

  test("upset: lower-rated winner gains more than equal-rated", () => {
    const { a: aUpset } = eloUpdatePair(1300, 1700, "won");
    const { a: aEqual } = eloUpdatePair(1500, 1500, "won");
    expect(aUpset - 1300).toBeGreaterThan(aEqual - 1500);
  });
});
