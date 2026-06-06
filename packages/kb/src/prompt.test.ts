// Unit tests for kb composeSystemPrompt — the prompt builder used by the reply
// pipeline (answer.ts). Focus: Phase 2 C-2 `stageOverride` precedence (the
// lead's funnel-stage goal/guidance wins over the Style's per-sales-stage cfg).

import { describe, expect, it } from "bun:test";
import { composeSystemPrompt } from "./prompt.ts";
import type { Style } from "./styles.ts";

const baseStyle: Style = {
  slug: "t",
  displayName: "T",
  persona: { name: "Алекс", role: "human" },
  voice: { tone: "friendly", language: "ru", forbid: [] },
  framework: "SPIN",
  hooks: [],
  stages: { qualify: { goal: "STYLE_GOAL", groundingRequired: false } },
  fewShot: [],
  guardrails: { noMinors: true, botDisclosureOnDirectQuestion: true, forbiddenTopics: [] },
  model: { id: "x", temperature: 0.5, maxTokens: 100 },
};

describe("composeSystemPrompt — stageOverride (Phase 2 C-2)", () => {
  it("без override → goal берётся из Style", () => {
    const p = composeSystemPrompt(baseStyle, "qualify");
    expect(p).toContain("STYLE_GOAL");
  });

  it("stageOverride имеет приоритет над Style для goal и guidance", () => {
    const p = composeSystemPrompt(baseStyle, "qualify", null, {
      stageOverride: { goal: "OVERRIDE_GOAL", guidance: "OVERRIDE_GUIDE" },
    });
    expect(p).toContain("OVERRIDE_GOAL");
    expect(p).toContain("OVERRIDE_GUIDE");
    expect(p).not.toContain("STYLE_GOAL");
  });

  it("stageOverride работает для стадии без конфига в Style", () => {
    // "close" нет в baseStyle.stages → раньше был бы generic-блок; теперь override.
    const p = composeSystemPrompt(baseStyle, "close", null, {
      stageOverride: { goal: "CLOSE_GOAL" },
    });
    expect(p).toContain("CLOSE_GOAL");
  });
});
