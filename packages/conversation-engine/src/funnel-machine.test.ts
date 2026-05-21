import type { VerticalTemplate } from "@chatman-media/verticals";
import { describe, expect, it } from "bun:test";
import {
  allowedTransitions,
  FunnelTransitionError,
  getInitialStage,
  isTerminal,
  validateTransition,
} from "./funnel-machine.ts";

const TEMPLATE: VerticalTemplate = {
  slug: "test_v1",
  displayName: "Test",
  version: 1,
  funnelStages: [
    { slug: "intake", kind: "intake", displayName: "Intake", next: ["qualified", "rejected"] },
    { slug: "qualified", kind: "lead", displayName: "Qualified", next: ["won", "rejected"] },
    { slug: "won", kind: "terminal", displayName: "Won" },
    { slug: "rejected", kind: "terminal", displayName: "Rejected" },
  ],
};

describe("funnel-machine", () => {
  it("getInitialStage возвращает первый stage из template", () => {
    expect(getInitialStage(TEMPLATE).slug).toBe("intake");
  });

  it("validateTransition allow'ает переход из next[]", () => {
    expect(() => validateTransition(TEMPLATE, "intake", "qualified")).not.toThrow();
    expect(() => validateTransition(TEMPLATE, "qualified", "won")).not.toThrow();
  });

  it("validateTransition allow'ает same-state (idempotent retry)", () => {
    expect(() => validateTransition(TEMPLATE, "qualified", "qualified")).not.toThrow();
  });

  it("validateTransition блокирует переход НЕ из next[]", () => {
    expect(() => validateTransition(TEMPLATE, "intake", "won")).toThrow(FunnelTransitionError);
  });

  it("validateTransition блокирует переход из terminal", () => {
    expect(() => validateTransition(TEMPLATE, "won", "qualified")).toThrow(/terminal/);
    expect(() => validateTransition(TEMPLATE, "rejected", "intake")).toThrow(/terminal/);
  });

  it("validateTransition блокирует переход в несуществующий stage", () => {
    expect(() => validateTransition(TEMPLATE, "intake", "zzz")).toThrow(/to-state/);
    expect(() => validateTransition(TEMPLATE, "yyy", "intake")).toThrow(/from-state/);
  });

  it("allowedTransitions возвращает next[]", () => {
    expect(allowedTransitions(TEMPLATE, "intake")).toEqual(["qualified", "rejected"]);
    expect(allowedTransitions(TEMPLATE, "won")).toEqual([]);
  });

  it("isTerminal различает терминалы", () => {
    expect(isTerminal(TEMPLATE, "intake")).toBe(false);
    expect(isTerminal(TEMPLATE, "won")).toBe(true);
    expect(isTerminal(TEMPLATE, "rejected")).toBe(true);
  });
});
