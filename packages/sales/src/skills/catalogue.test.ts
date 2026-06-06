import { describe, expect, it } from "bun:test";
import {
  SKILL_BY_SLUG,
  SKILL_CATALOGUE,
  SKILL_FAMILIES,
  SKILL_SLUGS,
  SkillSchema,
} from "./catalogue.ts";

describe("SKILL_CATALOGUE", () => {
  it("непустой и каждый элемент валиден по SkillSchema", () => {
    expect(SKILL_CATALOGUE.length).toBeGreaterThan(0);
    for (const s of SKILL_CATALOGUE) {
      const r = SkillSchema.safeParse(s);
      expect(r.success).toBe(true);
    }
  });
  it("слаги уникальны", () => {
    expect(new Set(SKILL_SLUGS).size).toBe(SKILL_SLUGS.length);
  });
  it("family каждого ∈ SKILL_FAMILIES", () => {
    for (const s of SKILL_CATALOGUE) {
      expect(SKILL_FAMILIES).toContain(s.family);
    }
  });
  it("SKILL_BY_SLUG согласован с каталогом и резолвит/не-резолвит", () => {
    expect(SKILL_BY_SLUG.size).toBe(SKILL_CATALOGUE.length);
    expect(SKILL_BY_SLUG.get(SKILL_SLUGS[0]!)?.slug).toBe(SKILL_SLUGS[0]);
    expect(SKILL_BY_SLUG.get("___no-such-skill___")).toBeUndefined();
  });
});
