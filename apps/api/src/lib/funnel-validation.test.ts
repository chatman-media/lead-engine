import { describe, expect, it } from "bun:test";
import {
  multiRequestBranchErrors,
  normalizeSeedStageConfigJson,
  parseAutoAdvanceConditionType,
  resolveSeedPhase,
  type SeedStage,
  stageWorkflowTransitions,
  validateFunnel,
  workflowBehaviorWarnings,
} from "./funnel-validation.ts";

function stage(over: Partial<SeedStage> = {}): SeedStage {
  return {
    slug: "s",
    displayName: "S",
    kind: "active",
    stageType: "interaction",
    position: 0,
    nextStages: [],
    fields: [],
    ...over,
  };
}

describe("parseAutoAdvanceConditionType", () => {
  it("достаёт type из JSON", () => {
    expect(parseAutoAdvanceConditionType('{"type":"all_required_fields_filled"}')).toBe(
      "all_required_fields_filled",
    );
  });
  it("пусто/битый/без type → null", () => {
    expect(parseAutoAdvanceConditionType(undefined)).toBeNull();
    expect(parseAutoAdvanceConditionType("{broken")).toBeNull();
    expect(parseAutoAdvanceConditionType('{"x":1}')).toBeNull();
  });
});

describe("stageWorkflowTransitions", () => {
  it("возвращает transitions из configJson.workflow", () => {
    const cfg = JSON.stringify({ workflow: { transitions: [{ to: "next" }] } });
    expect(stageWorkflowTransitions(cfg)).toEqual([{ to: "next" }]);
  });
  it("нет workflow/transitions/битый → []", () => {
    expect(stageWorkflowTransitions(undefined)).toEqual([]);
    expect(stageWorkflowTransitions("{broken")).toEqual([]);
    expect(stageWorkflowTransitions('{"workflow":{}}')).toEqual([]);
  });
});

describe("multiRequestBranchErrors", () => {
  it("линейная воронка без request_type → нет ошибок", () => {
    expect(multiRequestBranchErrors([stage({ kind: "intake" })])).toEqual([]);
  });
  it("request_type без опций → ошибка", () => {
    const intake = stage({
      kind: "intake",
      fields: [
        {
          slug: "request_type",
          displayName: "Тип",
          fieldType: "select",
          required: true,
          aiExtractable: false,
          position: 0,
        },
      ],
    });
    expect(multiRequestBranchErrors([intake])[0]).toContain("нет валидных опций");
  });
  it("опция без ветки → ошибка с подсказкой", () => {
    const intake = stage({
      kind: "intake",
      nextStages: ["exchange_request"],
      fields: [
        {
          slug: "request_type",
          displayName: "Тип",
          fieldType: "select",
          required: true,
          aiExtractable: false,
          position: 0,
          optionsJson: JSON.stringify([{ value: "exchange" }, { value: "transfer" }]),
        },
      ],
    });
    const errs = multiRequestBranchErrors([intake]);
    // exchange покрыт exchange_request, transfer — нет
    expect(errs.some((e) => e.includes('"transfer"'))).toBe(true);
    expect(errs.some((e) => e.includes('"exchange"'))).toBe(false);
  });
});

describe("workflowBehaviorWarnings", () => {
  it("active-стадия без goal/guidance/nextStages → предупреждения", () => {
    const w = workflowBehaviorWarnings([stage({ slug: "x" })]);
    expect(w.some((m) => m.includes("нет goal"))).toBe(true);
    expect(w.some((m) => m.includes("нет guidance"))).toBe(true);
    expect(w.some((m) => m.includes("нет nextStages"))).toBe(true);
  });
  it("awaiting_operator с goal/guidance → нет warning про exit", () => {
    const w = workflowBehaviorWarnings([
      stage({
        slug: "op",
        goal: "g",
        guidance: "h",
        stageType: "awaiting_operator",
        nextStages: ["done"],
      }),
    ]);
    expect(w.some((m) => m.includes("нет transition"))).toBe(false);
  });

  it("active c nextStages, но без transition/autoAdvance → warning про exit rule", () => {
    const w = workflowBehaviorWarnings([
      stage({
        slug: "stuck",
        goal: "g",
        guidance: "h",
        stageType: "interaction",
        nextStages: ["next"],
      }),
    ]);
    expect(w.some((m) => m.includes("нет transition/exit rule"))).toBe(true);
  });
});

describe("normalizeSeedStageConfigJson", () => {
  it("автодобавляет transition при all_required_fields_filled", () => {
    const out = normalizeSeedStageConfigJson({
      autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
      nextStages: ["next"],
      fields: [],
    });
    const parsed = JSON.parse(out) as { workflow: { transitions: Array<{ to?: string }> } };
    expect(parsed.workflow.transitions[0]?.to).toBe("next");
  });
  it("пустой конфиг → '{}'", () => {
    expect(normalizeSeedStageConfigJson({ nextStages: [], fields: [] })).toBe("{}");
  });
});

describe("resolveSeedPhase", () => {
  it("non-active → null", () => {
    expect(resolveSeedPhase({ kind: "intake", stageType: "form_fill" }, null)).toBeNull();
  });
  it("явная phase возвращается как есть", () => {
    expect(
      resolveSeedPhase({ kind: "active", stageType: "interaction", phase: "offer" }, null),
    ).toBe("offer");
  });
});

describe("validateFunnel", () => {
  it("агрегирует errors+warnings", () => {
    const res = validateFunnel([stage({ slug: "lonely" })]);
    expect(Array.isArray(res.errors)).toBe(true);
    expect(Array.isArray(res.warnings)).toBe(true);
  });
});
