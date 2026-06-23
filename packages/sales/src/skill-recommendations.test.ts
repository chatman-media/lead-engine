import { describe, expect, it } from "bun:test";
import { rankSkillRecommendations, wilsonLowerBound } from "./skill-recommendations.ts";
import type { SkillAggregate, SkillRow } from "./store.ts";

const skill = (over: Partial<SkillRow>): SkillRow =>
  ({ slug: "s", display_name: "S", family: "fam", is_enabled: true, ...over }) as SkillRow;
const agg = (over: Partial<SkillAggregate>): SkillAggregate =>
  ({ skill_slug: "s", wins: 0, losses: 0, draws: 0, count: 0, ...over }) as SkillAggregate;

describe("wilsonLowerBound", () => {
  it("total=0 → 0", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
  it("0 побед → 0", () => {
    expect(wilsonLowerBound(0, 10)).toBe(0);
  });
  it("больше выборка при той же доле → выше нижняя граница", () => {
    const small = wilsonLowerBound(3, 3);
    const big = wilsonLowerBound(60, 60);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThanOrEqual(1);
  });
  it("в диапазоне [0,1]", () => {
    const lb = wilsonLowerBound(7, 10);
    expect(lb).toBeGreaterThan(0);
    expect(lb).toBeLessThan(1);
  });
});

describe("rankSkillRecommendations", () => {
  it("исключает disabled и family=noise", () => {
    const out = rankSkillRecommendations(
      [
        skill({ slug: "ok" }),
        skill({ slug: "off", is_enabled: false }),
        skill({ slug: "noisy", family: "noise" }),
      ],
      [],
    );
    expect(out.map((r) => r.slug)).toEqual(["ok"]);
  });

  it("count < minSamples → confidence 0 и recommended=false", () => {
    const [r] = rankSkillRecommendations(
      [skill({ slug: "s" })],
      [agg({ skill_slug: "s", wins: 2, count: 2 })],
      {
        minSamples: 5,
      },
    );
    expect(r?.confidence_lower).toBe(0);
    expect(r?.recommended).toBe(false);
  });

  it("draws считаются как пол-победы (observed_rate)", () => {
    const [r] = rankSkillRecommendations(
      [skill({ slug: "s" })],
      [agg({ skill_slug: "s", wins: 4, draws: 2, count: 6 })],
    );
    expect(r?.observed_rate).toBeCloseTo((4 + 1) / 6, 6);
  });

  it("ранжирует по confidence_lower DESC и ставит recommended при сильной выборке", () => {
    const cat = [skill({ slug: "strong" }), skill({ slug: "weak" })];
    const aggs = [
      agg({ skill_slug: "strong", wins: 55, count: 60 }),
      agg({ skill_slug: "weak", wins: 6, losses: 4, count: 10 }),
    ];
    const out = rankSkillRecommendations(cat, aggs, { minSamples: 5, acceptThreshold: 0.4 });
    expect(out[0]!.slug).toBe("strong");
    expect(out[0]!.recommended).toBe(true);
    expect(out[0]!.confidence_lower).toBeGreaterThan(out[1]!.confidence_lower);
  });
});
