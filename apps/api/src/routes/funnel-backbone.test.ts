import { describe, expect, it } from "bun:test";
import { type ActivePhase, validateBackbone } from "@chatman-media/verticals";
import { resolveSeedPhase, SEED_TEMPLATES, type SeedStage } from "./admin-funnel.ts";

// Применяет ту же логику фаз, что applyFunnelStages (resolveSeedPhase), и
// проверяет, что каждый seed-шаблон удовлетворяет костяку без ошибок.
function withPhases(stages: SeedStage[]) {
  let prev: ActivePhase | null = null;
  return stages.map((s) => {
    const phase = resolveSeedPhase(s, prev);
    if (phase) prev = phase;
    return { ...s, phase: phase ?? undefined };
  });
}

describe("SEED_TEMPLATES соответствуют костяку", () => {
  for (const [key, stages] of Object.entries(SEED_TEMPLATES)) {
    it(`${key}: validateBackbone без ошибок`, () => {
      const v = validateBackbone(withPhases(stages));
      expect(v.errors).toEqual([]);
    });
  }
});

describe("5 вертикалей: явные теги фаз сохранены", () => {
  const expected: Record<string, Record<string, ActivePhase>> = {
    exchange: { exchange_request: "qualify", quote_calculated: "offer", kyc_collection: "clear", payment_verified: "fulfill" },
    video: { brief_call: "qualify", quote_approved: "offer", delivery: "fulfill" },
    recruitment: { intake_complete: "qualify", partner_review: "offer", visa_filing: "clear", ready_to_work: "fulfill" },
    real_estate: { viewings: "qualify", mou_signed: "offer", noc_application: "clear" },
    saas: { qualified: "qualify", demo_done: "qualify", proposal_sent: "offer" },
  };
  for (const [key, slugPhases] of Object.entries(expected)) {
    it(`${key}: ключевые стадии в ожидаемых фазах`, () => {
      const bySlug = new Map(SEED_TEMPLATES[key]!.map((s) => [s.slug, s]));
      for (const [slug, phase] of Object.entries(slugPhases)) {
        expect(bySlug.get(slug)?.phase).toBe(phase);
      }
    });
  }
});
