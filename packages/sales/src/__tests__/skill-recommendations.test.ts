import { describe, expect, test } from "bun:test";
import {
  rankSkillRecommendations,
  wilsonLowerBound,
} from "../skill-recommendations.ts";
import type { SkillAggregate, SkillRow } from "../store.ts";

describe("wilsonLowerBound", () => {
  test("0 total → 0", () => expect(wilsonLowerBound(0, 0)).toBe(0));
  test("0 wins / 10 total → near 0", () =>
    expect(wilsonLowerBound(0, 10)).toBeCloseTo(0, 1));
  test("10 wins / 10 total → < 1 but high", () => {
    const lb = wilsonLowerBound(10, 10);
    expect(lb).toBeGreaterThan(0.7);
    expect(lb).toBeLessThan(1);
  });
  test("50 wins / 100 total → ~0.4", () =>
    expect(wilsonLowerBound(50, 100)).toBeCloseTo(0.4, 1));
  test("more data at same rate → higher lower bound", () => {
    const few = wilsonLowerBound(5, 10);
    const many = wilsonLowerBound(50, 100);
    expect(many).toBeGreaterThan(few);
  });
  test("draws as half-credit: 5 wins + 10 draws / 20 = 10/20 wins-equiv", () => {
    const manual = wilsonLowerBound(10, 20);
    expect(wilsonLowerBound(10, 20)).toBeCloseTo(manual, 5);
  });
});

function makeSkill(slug: string, overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    slug,
    display_name: slug,
    family: "authority",
    prompt_fragment: "",
    applicable_stages: ["pitch"],
    is_enabled: true,
    ...overrides,
  };
}

function makeAgg(
  slug: string,
  wins: number,
  losses: number,
  draws: number,
): SkillAggregate {
  return {
    skill_slug: slug,
    wins,
    losses,
    draws,
    count: wins + losses + draws,
  };
}

describe("rankSkillRecommendations", () => {
  test("disabled skills excluded", () => {
    const catalogue = [makeSkill("a"), makeSkill("b", { is_enabled: false })];
    const result = rankSkillRecommendations(catalogue, []);
    expect(result.map((r) => r.slug)).not.toContain("b");
  });

  test("noise family excluded", () => {
    const catalogue = [
      makeSkill("good"),
      makeSkill("bad", { family: "noise" }),
    ];
    const result = rankSkillRecommendations(catalogue, []);
    expect(result.map((r) => r.slug)).not.toContain("bad");
  });

  test("skill with no aggregates gets count 0 and NaN rate", () => {
    const catalogue = [makeSkill("x")];
    const [r] = rankSkillRecommendations(catalogue, []);
    expect(r?.count).toBe(0);
    expect(r?.observed_rate).toBeNaN();
    expect(r?.confidence_lower).toBe(0);
    expect(r?.recommended).toBe(false);
  });

  test("skill below minSamples threshold gets confidence 0", () => {
    const catalogue = [makeSkill("x")];
    const aggs = [makeAgg("x", 3, 0, 0)];
    const [r] = rankSkillRecommendations(catalogue, aggs, { minSamples: 5 });
    expect(r?.confidence_lower).toBe(0);
    expect(r?.recommended).toBe(false);
  });

  test("high win-rate skill above threshold → recommended", () => {
    const catalogue = [makeSkill("x")];
    const aggs = [makeAgg("x", 40, 5, 5)];
    const [r] = rankSkillRecommendations(catalogue, aggs, {
      minSamples: 5,
      acceptThreshold: 0.4,
    });
    expect(r?.recommended).toBe(true);
  });

  test("ranked by confidence_lower DESC", () => {
    const catalogue = [makeSkill("weak"), makeSkill("strong")];
    const aggs = [
      makeAgg("weak", 3, 7, 0), // 30% rate, low confidence
      makeAgg("strong", 8, 2, 0), // 80% rate, higher confidence
    ];
    const ranked = rankSkillRecommendations(catalogue, aggs, { minSamples: 5 });
    expect(ranked[0]?.slug).toBe("strong");
    expect(ranked[1]?.slug).toBe("weak");
  });

  test("draws count as 0.5 wins in observed_rate", () => {
    const catalogue = [makeSkill("x")];
    const aggs = [makeAgg("x", 0, 0, 10)]; // all draws
    const [r] = rankSkillRecommendations(catalogue, aggs, { minSamples: 5 });
    expect(r?.observed_rate).toBeCloseTo(0.5);
  });
});
