// Unit test: every intake/active stage in every SEED_TEMPLATE must carry a
// non-empty goal + guidance (the per-stage behavior layer the bot reads).
// Terminal (won/lost) stages are exempt — the bot does not converse there.

import { describe, expect, it } from "bun:test";
import { SEED_TEMPLATES } from "./admin-funnel.ts";

describe("SEED_TEMPLATES per-stage goal/guidance", () => {
  for (const [name, stages] of Object.entries(SEED_TEMPLATES)) {
    it(`${name}: all intake/active stages have goal + guidance`, () => {
      const conversational = stages.filter((s) => s.kind === "intake" || s.kind === "active");
      expect(conversational.length).toBeGreaterThan(0);
      for (const s of conversational) {
        expect(
          (s.goal ?? "").trim().length,
          `${name}/${s.slug} goal must be non-empty`,
        ).toBeGreaterThan(0);
        expect(
          (s.guidance ?? "").trim().length,
          `${name}/${s.slug} guidance must be non-empty`,
        ).toBeGreaterThan(0);
      }
    });
  }
});
