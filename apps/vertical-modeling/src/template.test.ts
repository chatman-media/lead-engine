import { describe, expect, it } from "bun:test";
import { defaultRegistry } from "@chatman-media/verticals";
// Side-effect import регистрирует template в defaultRegistry.
import "./index.ts";

describe("modeling_v1 template", () => {
  it("регистрируется в defaultRegistry при import", () => {
    const t = defaultRegistry.load("modeling_v1");
    expect(t.displayName).toContain("Модельное");
    expect(t.version).toBe(1);
  });

  it("funnel-stages образуют валидную state machine", () => {
    const t = defaultRegistry.load("modeling_v1");
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

  it("intake stage существует и совпадает со ссылкой в questionnaire", () => {
    const t = defaultRegistry.load("modeling_v1");
    const intakeStage = t.funnelStages.find((s) => s.kind === "intake");
    expect(intakeStage).toBeDefined();
    expect(t.questionnaire?.stageSlug).toBe(intakeStage?.slug);
  });

  it("все required intake поля имеют непустое question", () => {
    const t = defaultRegistry.load("modeling_v1");
    for (const f of t.questionnaire?.fields ?? []) {
      if (f.required) {
        expect(f.question.length).toBeGreaterThan(0);
      }
    }
  });

  it("enum-поля имеют непустые options", () => {
    const t = defaultRegistry.load("modeling_v1");
    for (const f of t.questionnaire?.fields ?? []) {
      if (f.kind === "enum") {
        expect(f.options).toBeDefined();
        expect(f.options!.length).toBeGreaterThan(0);
      }
    }
  });

  it("три встроенных стиля, все с уникальными slug", () => {
    const t = defaultRegistry.load("modeling_v1");
    expect(t.styles).toHaveLength(3);
    const slugs = new Set(t.styles!.map((s) => s.slug));
    expect(slugs.size).toBe(3);
  });

  it("funnelSeedKey === 'modeling'", () => {
    const t = defaultRegistry.load("modeling_v1");
    expect(t.funnelSeedKey).toBe("modeling");
  });

  it("воронка содержит критические стадии: casting_review, city, not_suitable", () => {
    const t = defaultRegistry.load("modeling_v1");
    const slugs = new Set(t.funnelStages.map((s) => s.slug));
    expect(slugs.has("casting_review")).toBe(true);
    expect(slugs.has("city")).toBe(true);
    expect(slugs.has("not_suitable")).toBe(true);
  });
});
