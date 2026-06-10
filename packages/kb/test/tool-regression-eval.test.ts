import { describe, expect, test } from "bun:test";
import {
  formatToolCallRegressionFailures,
  runToolCallRegressionCases,
  toolCallRegressionExitCode,
} from "../src/tool-regression-eval.ts";

function validRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordType: "tool_call_regression_case",
    id: 17,
    proposalId: 5,
    toolCallId: 11,
    source: "tool_call_feedback",
    toolName: "create_exchange_order",
    label: "bad_args",
    title: "REG: order requires verified quote",
    input: {
      source: "rag_reply",
      toolName: "create_exchange_order",
      args: { quoteId: "q1" },
      feedback: { label: "bad_args", note: "accepted an unverified quote" },
    },
    expected: {
      behavior: "The agent must require a verified quote before order creation.",
      proposalKind: "schema_fix",
      actionItems: ["Reject unverified quote IDs."],
    },
    context: {
      toolCall: {
        id: 11,
        result: { orderId: "ord_1" },
        error: false,
        cycle: 0,
        toolCallIndex: 0,
        latencyMs: 42,
      },
    },
    status: "active",
    createdByAdminId: 3,
    createdAt: 1781077061,
    updatedAt: 1781077061,
    ...over,
  };
}

function jsonl(...records: Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("tool-call regression eval", () => {
  test("passes valid active JSONL records and ignores comments", () => {
    const report = runToolCallRegressionCases({
      raw: `# exported from Quality Lab\n${jsonl(validRecord({ id: 1 }), validRecord({ id: 2 }))}`,
    });

    expect(report.summary).toMatchObject({
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    expect(report.results.map((result) => result.caseId)).toEqual([1, 2]);
    expect(toolCallRegressionExitCode(report)).toBe(0);
  });

  test("reports malformed JSONL with line numbers", () => {
    const report = runToolCallRegressionCases({ raw: '{"recordType":\n' });

    expect(report.summary.failed).toBe(1);
    expect(toolCallRegressionExitCode(report)).toBe(1);
    expect(formatToolCallRegressionFailures(report)).toContain("line=1");
    expect(formatToolCallRegressionFailures(report)).toContain("valid JSON object");
  });

  test("fails invalid record shape with actionable paths", () => {
    const report = runToolCallRegressionCases({
      raw: jsonl(
        validRecord({
          expected: { proposalKind: "schema_fix" },
          input: { toolName: "other_tool", args: [] },
        }),
      ),
    });

    const formatted = formatToolCallRegressionFailures(report);
    expect(report.summary.failed).toBe(1);
    expect(formatted).toContain("path=input.toolName");
    expect(formatted).toContain("path=input.args");
    expect(formatted).toContain("path=expected.behavior");
  });

  test("skips archived cases by default and validates them when included", () => {
    const report = runToolCallRegressionCases({
      raw: jsonl(validRecord({ status: "archived", expected: {} })),
    });
    expect(report.summary).toMatchObject({
      total: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
      archived: 1,
    });
    expect(report.results[0]?.skipReason).toBe("archived");

    const included = runToolCallRegressionCases({
      raw: jsonl(validRecord({ status: "archived", expected: {} })),
      includeArchived: true,
    });
    expect(included.summary).toMatchObject({ failed: 1, archived: 1 });
    expect(formatToolCallRegressionFailures(included)).toContain("expected.behavior");
  });

  test("fails unsupported tools unless the caller explicitly skips them", () => {
    const raw = jsonl(validRecord({ toolName: "create_exchange_order" }));

    const failed = runToolCallRegressionCases({
      raw,
      supportedTools: ["offer_booking_link"],
    });
    expect(failed.summary.failed).toBe(1);
    expect(formatToolCallRegressionFailures(failed)).toContain("path=toolName");

    const skipped = runToolCallRegressionCases({
      raw,
      supportedTools: ["offer_booking_link"],
      skipUnsupported: true,
    });
    expect(skipped.summary).toMatchObject({
      failed: 0,
      skipped: 1,
      unsupported: 1,
    });
    expect(skipped.results[0]?.skipReason).toBe("unsupported_tool");
    expect(toolCallRegressionExitCode(skipped)).toBe(0);
  });
});
