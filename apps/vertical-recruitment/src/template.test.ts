import { describe, expect, it } from "bun:test";
import { defaultRegistry } from "@chatman-media/verticals";
// Side-effect import регистрирует template в defaultRegistry.
import "./index.ts";

describe("recruitment_v1 template", () => {
  it("регистрируется в defaultRegistry при import", () => {
    const t = defaultRegistry.load("recruitment_v1");
    expect(t.displayName).toBe("Найм (рекрутинг артисток) — v1");
    expect(t.version).toBe(1);
  });

  it("funnel-stages образуют валидную state machine", () => {
    const t = defaultRegistry.load("recruitment_v1");
    const slugs = new Set(t.funnelStages.map((s) => s.slug));
    // Каждый next[] ссылается на существующий slug.
    for (const stage of t.funnelStages) {
      for (const nxt of stage.next ?? []) {
        expect(slugs.has(nxt)).toBe(true);
      }
    }
    // Terminal стадии не имеют next.
    for (const stage of t.funnelStages) {
      if (stage.kind === "terminal") {
        expect(stage.next).toBeUndefined();
      }
    }
  });

  it("intake stage существует в funnel и совпадает со ссылкой в questionnaire", () => {
    const t = defaultRegistry.load("recruitment_v1");
    const intakeStage = t.funnelStages.find((s) => s.kind === "intake");
    expect(intakeStage).toBeDefined();
    expect(t.questionnaire?.stageSlug).toBe(intakeStage?.slug);
  });

  it("все required intake поля имеют непустое question", () => {
    const t = defaultRegistry.load("recruitment_v1");
    for (const f of t.questionnaire?.fields ?? []) {
      if (f.required) {
        expect(f.question.length).toBeGreaterThan(0);
      }
    }
  });

  it("enum-поля имеют непустые options", () => {
    const t = defaultRegistry.load("recruitment_v1");
    for (const f of t.questionnaire?.fields ?? []) {
      if (f.kind === "enum") {
        expect(f.options).toBeDefined();
        expect(f.options!.length).toBeGreaterThan(0);
      }
    }
  });
});
