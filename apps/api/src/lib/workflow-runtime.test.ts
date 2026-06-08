import { describe, expect, it } from "bun:test";
import { evaluateTransition, selectNextStage } from "./workflow-runtime.ts";

const linearStage = {
  nextStages: ["offer", "lost"],
  autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
  configJson: "{}",
};

describe("workflow transition evaluator", () => {
  it("keeps legacy linear nextStages[0] fallback", () => {
    expect(
      evaluateTransition({
        stage: linearStage,
        hasRequestTypeField: false,
        requestType: null,
        allRequiredFieldsFilled: true,
        eventType: "message_received",
      }),
    ).toEqual({
      nextSlug: "offer",
      requestType: null,
      reason: "legacy_auto_advance",
      condition: "all_required_fields_filled",
    });
  });

  it("selects request_type branch for branching workflows", () => {
    expect(
      evaluateTransition({
        stage: {
          ...linearStage,
          nextStages: ["exchange_request", "transfer_request", "cancelled"],
        },
        hasRequestTypeField: true,
        requestType: "transfer",
        allRequiredFieldsFilled: true,
        eventType: "field_updated",
      }),
    ).toEqual({
      nextSlug: "transfer_request",
      requestType: "transfer",
      reason: "legacy_auto_advance",
      condition: "all_required_fields_filled",
    });
  });

  it("uses configJson.workflow.transitions before legacy nextStages", () => {
    const transition = evaluateTransition({
      stage: {
        nextStages: ["first_next", "rule_next"],
        autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
        configJson: JSON.stringify({
          workflow: {
            transitions: [
              { to: "first_next", when: { type: "all_required_fields_filled" }, priority: 1 },
              { to: "rule_next", when: { type: "all_required_fields_filled" }, priority: 10 },
            ],
          },
        }),
      },
      hasRequestTypeField: false,
      requestType: null,
      allRequiredFieldsFilled: true,
      eventType: "message_received",
    });

    expect(transition).toEqual({
      nextSlug: "rule_next",
      requestType: null,
      reason: "workflow_transition",
      condition: "all_required_fields_filled",
    });
  });

  it("does not transition until all required fields are filled", () => {
    expect(
      evaluateTransition({
        stage: linearStage,
        hasRequestTypeField: false,
        requestType: null,
        allRequiredFieldsFilled: false,
        eventType: "message_received",
      }),
    ).toBeNull();
  });

  it("does not auto-transition on non field/message workflow events", () => {
    expect(
      evaluateTransition({
        stage: linearStage,
        hasRequestTypeField: false,
        requestType: null,
        allRequiredFieldsFilled: true,
        eventType: "operator_advanced",
      }),
    ).toBeNull();
  });
});

describe("selectNextStage compatibility export", () => {
  it("returns null for unknown branching request_type", () => {
    expect(
      selectNextStage({
        nextStages: ["exchange_request", "transfer_request"],
        hasRequestTypeField: true,
        requestType: "other",
      }),
    ).toBeNull();
  });
});
