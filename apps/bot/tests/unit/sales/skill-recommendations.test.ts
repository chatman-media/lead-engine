import { describe, expect, test } from "bun:test";

import type { SkillAggregate } from "@/db/repos/skill-outcomes.ts";
import type { SkillRow } from "@/db/repos/skills.ts";
import { rankSkillRecommendations, wilsonLowerBound } from "@/sales/skill-recommendations.ts";

function row(slug: string, family = "cialdini", enabled = true): SkillRow {
  return {
    id: 0,
    slug,
    family,
    display_name: slug,
    description: "",
    prompt_fragment: "",
    applicable_stages_json: "[]",
    intent: "",
    is_enabled: enabled ? 1 : 0,
    created_at: 0,
    updated_at: 0,
  };
}

function agg(slug: string, wins: number, losses: number, draws = 0): SkillAggregate {
  const count = wins + losses + draws;
  return {
    skill_slug: slug,
    count,
    wins,
    losses,
    draws,
    win_rate: count > 0 ? wins / count : Number.NaN,
  };
}

describe("wilsonLowerBound", () => {
  test("returns 0 for n=0", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  test("100% wins on small sample is bounded below 1", () => {
    // 3/3 wins → Wilson lb at 95% should be far below the observed 1.0
    expect(wilsonLowerBound(3, 3)).toBeLessThan(0.5);
  });

  test("more samples tighten the bound", () => {
    const small = wilsonLowerBound(8, 10);
    const large = wilsonLowerBound(80, 100);
    expect(large).toBeGreaterThan(small);
  });

  test("0 wins out of N returns 0", () => {
    expect(wilsonLowerBound(0, 100)).toBe(0);
  });

  test("symmetric: half-wins yields lb < 0.5 due to z-margin", () => {
    expect(wilsonLowerBound(5, 10)).toBeLessThan(0.5);
  });
});

describe("rankSkillRecommendations", () => {
  test("excludes disabled skills + 'noise' family", () => {
    const ranked = rankSkillRecommendations(
      [row("a"), row("noisy", "noise"), row("disabled-one", "voss", false)],
      [],
    );
    expect(ranked.map((r) => r.slug)).toEqual(["a"]);
  });

  test("recommends only when count >= minSamples and lb >= accept", () => {
    const catalogue = [row("hot"), row("untested"), row("cold")];
    const aggregates = [
      agg("hot", 18, 2), // 90% on 20 samples → lb high
      agg("untested", 3, 0), // 100% but tiny n → not recommended
      agg("cold", 2, 18), // 10% on 20 samples → lb low
    ];
    const ranked = rankSkillRecommendations(catalogue, aggregates, {
      minSamples: 5,
      acceptThreshold: 0.5,
    });
    const hot = ranked.find((r) => r.slug === "hot")!;
    const untested = ranked.find((r) => r.slug === "untested")!;
    const cold = ranked.find((r) => r.slug === "cold")!;
    expect(hot.recommended).toBe(true);
    expect(untested.recommended).toBe(false); // count < minSamples
    expect(cold.recommended).toBe(false); // lb below accept
  });

  test("draws count as half-wins (consistent with ELO actual-score)", () => {
    const ranked = rankSkillRecommendations(
      [row("draws-only"), row("wins-only")],
      [agg("draws-only", 0, 0, 20), agg("wins-only", 10, 10)],
      { minSamples: 5, acceptThreshold: 0.5 },
    );
    const drawsOnly = ranked.find((r) => r.slug === "draws-only")!;
    const winsOnly = ranked.find((r) => r.slug === "wins-only")!;
    // Both yield ~50% observed rate; both should NOT be recommended at 0.5 threshold.
    expect(drawsOnly.observed_rate).toBeCloseTo(0.5, 6);
    expect(winsOnly.observed_rate).toBeCloseTo(0.5, 6);
  });

  test("ranks by confidence_lower DESC, count DESC tiebreak", () => {
    const ranked = rankSkillRecommendations(
      [row("more-data"), row("less-data"), row("untested")],
      [
        agg("more-data", 80, 20), // 80% on 100 → lb ≈ 0.71
        agg("less-data", 8, 2), //   80% on 10 → lb ≈ 0.49
        agg("untested", 5, 0), //    100% on 5 — under minSamples=10 → lb=0
      ],
      { minSamples: 10 },
    );
    expect(ranked[0]!.slug).toBe("more-data");
    expect(ranked[1]!.slug).toBe("less-data");
    expect(ranked[2]!.slug).toBe("untested");
  });

  test("skills with zero outcomes have observed_rate = NaN, lb = 0", () => {
    const ranked = rankSkillRecommendations([row("never-used")], []);
    const r = ranked[0]!;
    expect(Number.isNaN(r.observed_rate)).toBe(true);
    expect(r.confidence_lower).toBe(0);
    expect(r.recommended).toBe(false);
  });
});
