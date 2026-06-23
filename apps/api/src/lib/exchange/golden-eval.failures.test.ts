/**
 * Ветки фиксации провалов golden-eval недостижимы на здоровом коде: stage-матрица
 * и reply-guard детерминированы и всегда «зелёные» для встроенных ожиданий.
 * Покрываем их, временно подменяя guard-функции через mock.module и ВОССТАНАВЛИВАЯ
 * оригиналы в finally (bun test гоняет файлы в одном процессе).
 */
import { describe, expect, it, mock } from "bun:test";
import * as engine from "@chatman-media/conversation-engine";
import { evaluateExchangeGoldenCase } from "./golden-eval.ts";
import * as tools from "./tools.ts";

const realGuardReply = engine.guardExchangeReply;
const realGuardStage = tools.guardExchangeToolForStage;

describe("exchange golden eval — failure recording branches", () => {
  it("records a workflow failure when stage policy denies the expected tool", () => {
    mock.module("./tools.ts", () => ({
      ...tools,
      guardExchangeToolForStage: (toolName: string, stageSlug: string | null | undefined) => ({
        ok: false as const,
        needsOperator: true as const,
        reason: "action_not_allowed_for_stage" as const,
        toolName,
        stageSlug: String(stageSlug),
        allowedTools: [],
        note: "denied for coverage",
      }),
    }));
    try {
      const result = evaluateExchangeGoldenCase({
        id: "coverage-denied-workflow",
        title: "denied workflow",
        expectedWorkflow: ["rate_quote", "unknown_token_is_skipped"],
        messages: [],
      });
      expect(result.passed).toBe(false);
      expect(
        result.failures.some((failure) =>
          failure.actual.includes("compute_exchange_quote denied at exchange_request"),
        ),
      ).toBe(true);
      expect(result.trace).toContain("rate_quote: exchange_request -> compute_exchange_quote");
    } finally {
      mock.module("./tools.ts", () => ({
        ...tools,
        guardExchangeToolForStage: realGuardStage,
      }));
    }
  });

  it("records draft failures when the reply guard allows or misclassifies drafts", () => {
    let call = 0;
    mock.module("@chatman-media/conversation-engine", () => ({
      ...engine,
      guardExchangeReply: () => {
        call += 1;
        if (call === 1) return { ok: true as const };
        if (call === 2) return { ok: false as const, reason: "some_other_reason" };
        return { ok: false as const };
      },
    }));
    try {
      const result = evaluateExchangeGoldenCase({
        id: "coverage-guard-misfire",
        title: "guard misfire",
        expectedWorkflow: [],
        messages: [],
      });
      expect(result.passed).toBe(false);
      expect(result.failures.some((failure) => failure.actual === "draft was allowed")).toBe(true);
      expect(
        result.failures.some((failure) => failure.actual === "blocked with some_other_reason"),
      ).toBe(true);
      expect(result.failures.some((failure) => failure.actual === "blocked with unknown")).toBe(
        true,
      );
    } finally {
      mock.module("@chatman-media/conversation-engine", () => ({
        ...engine,
        guardExchangeReply: realGuardReply,
      }));
    }
  });

  it("guards are restored: built-in golden expectations stay green", () => {
    const result = evaluateExchangeGoldenCase({
      id: "coverage-restored",
      title: "restored",
      expectedWorkflow: ["rate_quote", "receipt_request"],
      messages: [],
    });
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});
