import { describe, expect, it } from "bun:test";
import { defaultRegistry } from "@chatman-media/verticals";
// Side-effect import регистрирует template в defaultRegistry.
import "./index.ts";

describe("real_estate_v1 template", () => {
  it("регистрируется в defaultRegistry при import", () => {
    const t = defaultRegistry.load("real_estate_v1");
    expect(t.displayName).toBe("Недвижимость — v1");
    expect(t.version).toBe(1);
  });

  it("funnel-stages образуют валидную state machine", () => {
    const t = defaultRegistry.load("real_estate_v1");
    const slugs = new Set(t.funnelStages.map((s) => s.slug));
    for (const stage of t.funnelStages) {
      for (const nxt of stage.next ?? []) {
        expect(slugs.has(nxt)).toBe(true);
      }
    }
    for (const stage of t.funnelStages) {
      if (stage.kind === "terminal") {
        expect(stage.next).toBeUndefined();
      }
    }
  });

  it("intake stage существует в funnel и совпадает со ссылкой в questionnaire", () => {
    const t = defaultRegistry.load("real_estate_v1");
    const intakeStage = t.funnelStages.find((s) => s.kind === "intake");
    expect(intakeStage).toBeDefined();
    expect(t.questionnaire?.stageSlug).toBe(intakeStage?.slug);
  });

  it("все required intake поля имеют непустое question", () => {
    const t = defaultRegistry.load("real_estate_v1");
    for (const f of t.questionnaire?.fields ?? []) {
      if (f.required) {
        expect(f.question.length).toBeGreaterThan(0);
      }
    }
  });

  it("seed KB docs имеют валидные scope", () => {
    const t = defaultRegistry.load("real_estate_v1");
    const slugs = new Set(t.funnelStages.map((s) => s.slug));
    expect(t.kbDocuments?.length).toBeGreaterThan(0);
    for (const doc of t.kbDocuments ?? []) {
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.body.length).toBeGreaterThan(0);
      if (doc.scope?.scopeType === "stage") {
        expect(slugs.has(doc.scope.stageSlug)).toBe(true);
      }
    }
  });
});
