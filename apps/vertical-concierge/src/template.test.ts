import { describe, expect, it } from "bun:test";
import { defaultRegistry } from "@chatman-media/verticals";
// Side-effect import регистрирует template в defaultRegistry.
import "./index.ts";

describe("concierge_v1 template", () => {
  it("регистрируется в defaultRegistry при import", () => {
    const t = defaultRegistry.load("concierge_v1");
    expect(t.displayName).toBe("Консьерж-сервис — v1");
    expect(t.version).toBe(1);
    expect(t.funnelSeedKey).toBe("concierge");
  });

  it("funnel-stages образуют валидную state machine", () => {
    const t = defaultRegistry.load("concierge_v1");
    const slugs = new Set(t.funnelStages.map((s) => s.slug));
    for (const stage of t.funnelStages) {
      for (const next of stage.next ?? []) {
        expect(slugs.has(next)).toBe(true);
      }
    }
    for (const stage of t.funnelStages) {
      if (stage.kind === "terminal") {
        expect(stage.next).toBeUndefined();
      }
    }
  });

  it("ровно один intake, и он совпадает со ссылкой в questionnaire", () => {
    const t = defaultRegistry.load("concierge_v1");
    const intakes = t.funnelStages.filter((s) => s.kind === "intake");
    expect(intakes.length).toBe(1);
    expect(t.questionnaire?.stageSlug).toBe(intakes[0]?.slug);
  });

  it("intake ветвится во все три типа запроса", () => {
    const t = defaultRegistry.load("concierge_v1");
    const intake = t.funnelStages.find((s) => s.kind === "intake");
    expect(intake?.next).toEqual(
      expect.arrayContaining(["exchange_request", "transfer_request", "food_request"]),
    );
  });

  it("все required intake поля имеют непустое question", () => {
    const t = defaultRegistry.load("concierge_v1");
    for (const field of t.questionnaire?.fields ?? []) {
      if (field.required) {
        expect(field.question.length).toBeGreaterThan(0);
      }
    }
  });
});
