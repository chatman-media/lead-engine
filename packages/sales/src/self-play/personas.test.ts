import { describe, expect, it } from "bun:test";
import { CANDIDATE_BY_SLUG, CANDIDATE_PERSONAS } from "./personas.ts";

describe("CANDIDATE_PERSONAS", () => {
  it("непустой, слаги уникальны", () => {
    expect(CANDIDATE_PERSONAS.length).toBeGreaterThan(0);
    const slugs = CANDIDATE_PERSONAS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
  it("у каждого непустые systemPrompt/opener/judgingHint/displayName", () => {
    for (const p of CANDIDATE_PERSONAS) {
      expect(p.displayName.length).toBeGreaterThan(0);
      expect(p.systemPrompt.length).toBeGreaterThan(0);
      expect(p.opener.length).toBeGreaterThan(0);
      expect(p.judgingHint.length).toBeGreaterThan(0);
    }
  });
  it("CANDIDATE_BY_SLUG согласован и резолвит/не-резолвит", () => {
    expect(CANDIDATE_BY_SLUG.size).toBe(CANDIDATE_PERSONAS.length);
    const slug = CANDIDATE_PERSONAS[0]!.slug;
    expect(CANDIDATE_BY_SLUG.get(slug)?.slug).toBe(slug);
    expect(CANDIDATE_BY_SLUG.get("___no-persona___")).toBeUndefined();
  });
});
