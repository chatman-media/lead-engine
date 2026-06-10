export const TOOL_CALL_REGRESSION_RECORD_TYPE = "tool_call_regression_case" as const;

export type ToolCallRegressionCaseStatus = "active" | "archived";
export type ToolCallRegressionCaseLabel = "wrong_tool" | "missing_tool" | "bad_args";
export type ToolCallRegressionCaseResultStatus = "passed" | "failed" | "skipped";

export interface ToolCallRegressionCaseRecord {
  recordType: typeof TOOL_CALL_REGRESSION_RECORD_TYPE;
  id: number;
  proposalId: number | null;
  toolCallId: number | null;
  source: "tool_call_feedback";
  toolName: string;
  label: ToolCallRegressionCaseLabel;
  title: string;
  input: {
    source?: string;
    toolName: string;
    args: Record<string, unknown> | null;
    feedback?: {
      label?: ToolCallRegressionCaseLabel;
      note?: string | null;
    };
  };
  expected: {
    behavior: string;
    proposalKind?: string;
    actionItems?: string[];
  };
  context: Record<string, unknown>;
  status: ToolCallRegressionCaseStatus;
  createdByAdminId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ToolCallRegressionFailure {
  line: number;
  caseId: number | null;
  toolName: string | null;
  path: string;
  expected: string;
  actual: string;
}

export interface ToolCallRegressionCaseResult {
  line: number;
  status: ToolCallRegressionCaseResultStatus;
  recordStatus: ToolCallRegressionCaseStatus | null;
  caseId: number | null;
  toolName: string | null;
  title: string | null;
  skipReason?: "archived" | "unsupported_tool";
  failures: ToolCallRegressionFailure[];
}

export interface ToolCallRegressionSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  active: number;
  archived: number;
  unsupported: number;
  skipReasons: Record<string, number>;
}

export interface ToolCallRegressionReport {
  generatedAt: string;
  metadata?: Record<string, unknown>;
  summary: ToolCallRegressionSummary;
  results: ToolCallRegressionCaseResult[];
}

export interface ToolCallRegressionRunInput {
  raw: string;
  supportedTools?: Iterable<string>;
  includeArchived?: boolean;
  skipUnsupported?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ParsedToolCallRegressionJsonlLine {
  line: number;
  value?: unknown;
  parseError?: string;
}

interface RegressionIdentity {
  caseId: number | null;
  toolName: string | null;
  title: string | null;
  status: ToolCallRegressionCaseStatus | null;
}

const LABELS = new Set<ToolCallRegressionCaseLabel>(["wrong_tool", "missing_tool", "bad_args"]);
const STATUSES = new Set<ToolCallRegressionCaseStatus>(["active", "archived"]);

export function runToolCallRegressionCases(
  input: ToolCallRegressionRunInput,
): ToolCallRegressionReport {
  const supportedTools = input.supportedTools ? new Set(input.supportedTools) : null;
  const results = parseToolCallRegressionJsonl(input.raw).map((line) =>
    evaluateParsedLine(line, {
      supportedTools,
      includeArchived: input.includeArchived ?? false,
      skipUnsupported: input.skipUnsupported ?? false,
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    summary: summarizeToolRegressionResults(results),
    results,
  };
}

export function parseToolCallRegressionJsonl(raw: string): ParsedToolCallRegressionJsonlLine[] {
  const parsed: ParsedToolCallRegressionJsonlLine[] = [];
  const lines = raw.split("\n");

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    try {
      parsed.push({ line: index + 1, value: JSON.parse(line) });
    } catch (err) {
      parsed.push({
        line: index + 1,
        parseError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return parsed;
}

export function formatToolCallRegressionFailures(report: ToolCallRegressionReport): string {
  const failures = report.results.flatMap((result) => result.failures);
  if (failures.length === 0) return "";

  return failures
    .map((failure) =>
      [
        `line=${failure.line}`,
        `case=${failure.caseId ?? "unknown"}`,
        `tool=${failure.toolName ?? "unknown"}`,
        `path=${failure.path}`,
        `expected=${failure.expected}`,
        `actual=${failure.actual}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function toolCallRegressionExitCode(report: ToolCallRegressionReport): 0 | 1 {
  return report.summary.failed > 0 ? 1 : 0;
}

function evaluateParsedLine(
  line: ParsedToolCallRegressionJsonlLine,
  options: {
    supportedTools: Set<string> | null;
    includeArchived: boolean;
    skipUnsupported: boolean;
  },
): ToolCallRegressionCaseResult {
  if (line.parseError) {
    return failedResult(line.line, emptyIdentity(), [
      failure(line.line, emptyIdentity(), "$", "valid JSON object", line.parseError),
    ]);
  }

  const identity = readIdentity(line.value);
  const headerFailures = validateHeader(line.line, line.value, identity);
  if (headerFailures.length > 0) {
    return failedResult(line.line, identity, headerFailures);
  }

  if (identity.status === "archived" && !options.includeArchived) {
    return skippedResult(line.line, identity, "archived");
  }

  const record = line.value as ToolCallRegressionCaseRecord;
  const fullFailures = validateRecordBody(line.line, record);
  if (fullFailures.length > 0) {
    return failedResult(line.line, identity, fullFailures);
  }

  if (options.supportedTools && !options.supportedTools.has(record.toolName)) {
    if (options.skipUnsupported) {
      return skippedResult(line.line, identity, "unsupported_tool");
    }
    return failedResult(line.line, identity, [
      failure(
        line.line,
        identity,
        "toolName",
        `one of: ${[...options.supportedTools].sort().join(", ")}`,
        record.toolName,
      ),
    ]);
  }

  return {
    line: line.line,
    status: "passed",
    recordStatus: identity.status,
    caseId: identity.caseId,
    toolName: identity.toolName,
    title: identity.title,
    failures: [],
  };
}

function validateHeader(
  line: number,
  value: unknown,
  identity: RegressionIdentity,
): ToolCallRegressionFailure[] {
  const failures: ToolCallRegressionFailure[] = [];
  const fail = (path: string, expected: string, actual: unknown) => {
    failures.push(failure(line, identity, path, expected, describeValue(actual)));
  };

  if (!isRecord(value)) {
    fail("$", "object", value);
    return failures;
  }

  if (value.recordType !== TOOL_CALL_REGRESSION_RECORD_TYPE) {
    fail("recordType", TOOL_CALL_REGRESSION_RECORD_TYPE, value.recordType);
  }
  if (!isPositiveInteger(value.id)) {
    fail("id", "positive integer", value.id);
  }
  if (value.source !== "tool_call_feedback") {
    fail("source", "tool_call_feedback", value.source);
  }
  if (!isNonEmptyString(value.toolName)) {
    fail("toolName", "non-empty string", value.toolName);
  }
  if (!isToolCallRegressionLabel(value.label)) {
    fail("label", "wrong_tool | missing_tool | bad_args", value.label);
  }
  if (!isNonEmptyString(value.title)) {
    fail("title", "non-empty string", value.title);
  }
  if (!isToolCallRegressionStatus(value.status)) {
    fail("status", "active | archived", value.status);
  }

  return failures;
}

function validateRecordBody(
  line: number,
  record: ToolCallRegressionCaseRecord,
): ToolCallRegressionFailure[] {
  const failures: ToolCallRegressionFailure[] = [];
  const identity = readIdentity(record);
  const fail = (path: string, expected: string, actual: unknown) => {
    failures.push(failure(line, identity, path, expected, describeValue(actual)));
  };

  if (!isPositiveIntegerOrNull(record.proposalId)) {
    fail("proposalId", "positive integer or null", record.proposalId);
  }
  if (!isPositiveIntegerOrNull(record.toolCallId)) {
    fail("toolCallId", "positive integer or null", record.toolCallId);
  }
  if (!isRecord(record.input)) {
    fail("input", "object", record.input);
  } else {
    validateInput(line, record, fail);
  }
  if (!isRecord(record.expected)) {
    fail("expected", "object", record.expected);
  } else {
    if (!isNonEmptyString(record.expected.behavior)) {
      fail("expected.behavior", "non-empty string", record.expected.behavior);
    }
    if (record.expected.actionItems !== undefined && !isStringArray(record.expected.actionItems)) {
      fail("expected.actionItems", "string array", record.expected.actionItems);
    }
    if (
      record.expected.proposalKind !== undefined &&
      !isNonEmptyString(record.expected.proposalKind)
    ) {
      fail("expected.proposalKind", "non-empty string", record.expected.proposalKind);
    }
  }
  if (!isRecord(record.context)) {
    fail("context", "object", record.context);
  } else {
    validateContext(record, fail);
  }
  if (!isPositiveIntegerOrNull(record.createdByAdminId)) {
    fail("createdByAdminId", "positive integer or null", record.createdByAdminId);
  }
  if (!isPositiveInteger(record.createdAt)) {
    fail("createdAt", "positive integer epoch seconds", record.createdAt);
  }
  if (!isPositiveInteger(record.updatedAt)) {
    fail("updatedAt", "positive integer epoch seconds", record.updatedAt);
  }

  return failures;
}

function validateInput(
  _line: number,
  record: ToolCallRegressionCaseRecord,
  fail: (path: string, expected: string, actual: unknown) => void,
) {
  const input = record.input as Record<string, unknown>;
  if (input.source !== undefined && !isNonEmptyString(input.source)) {
    fail("input.source", "non-empty string", input.source);
  }
  if (input.toolName !== record.toolName) {
    fail("input.toolName", record.toolName, input.toolName);
  }
  if (input.args !== null && !isRecord(input.args)) {
    fail("input.args", "object or null", input.args);
  }

  if (input.feedback !== undefined) {
    if (!isRecord(input.feedback)) {
      fail("input.feedback", "object", input.feedback);
      return;
    }
    if (input.feedback.label !== undefined && input.feedback.label !== record.label) {
      fail("input.feedback.label", record.label, input.feedback.label);
    }
    if (
      input.feedback.note !== undefined &&
      input.feedback.note !== null &&
      typeof input.feedback.note !== "string"
    ) {
      fail("input.feedback.note", "string or null", input.feedback.note);
    }
  }
}

function validateContext(
  record: ToolCallRegressionCaseRecord,
  fail: (path: string, expected: string, actual: unknown) => void,
) {
  const toolCall = record.context.toolCall;
  if (toolCall === undefined) return;
  if (!isRecord(toolCall)) {
    fail("context.toolCall", "object", toolCall);
    return;
  }

  if (!("result" in toolCall)) {
    fail("context.toolCall.result", "present", "missing");
  }
  if (typeof toolCall.error !== "boolean") {
    fail("context.toolCall.error", "boolean", toolCall.error);
  }
  if (toolCall.cycle !== undefined && !isInteger(toolCall.cycle)) {
    fail("context.toolCall.cycle", "integer", toolCall.cycle);
  }
  if (toolCall.toolCallIndex !== undefined && !isInteger(toolCall.toolCallIndex)) {
    fail("context.toolCall.toolCallIndex", "integer", toolCall.toolCallIndex);
  }
  if (
    toolCall.latencyMs !== undefined &&
    toolCall.latencyMs !== null &&
    !isInteger(toolCall.latencyMs)
  ) {
    fail("context.toolCall.latencyMs", "integer or null", toolCall.latencyMs);
  }
}

function summarizeToolRegressionResults(
  results: ToolCallRegressionCaseResult[],
): ToolCallRegressionSummary {
  const skipReasons: Record<string, number> = {};
  for (const result of results) {
    if (!result.skipReason) continue;
    skipReasons[result.skipReason] = (skipReasons[result.skipReason] ?? 0) + 1;
  }

  return {
    total: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    active: results.filter((result) => result.recordStatus === "active").length,
    archived: results.filter((result) => result.recordStatus === "archived").length,
    unsupported: results.filter((result) => result.skipReason === "unsupported_tool").length,
    skipReasons,
  };
}

function failedResult(
  line: number,
  identity: RegressionIdentity,
  failures: ToolCallRegressionFailure[],
): ToolCallRegressionCaseResult {
  return {
    line,
    status: "failed",
    recordStatus: identity.status,
    caseId: identity.caseId,
    toolName: identity.toolName,
    title: identity.title,
    failures,
  };
}

function skippedResult(
  line: number,
  identity: RegressionIdentity,
  skipReason: "archived" | "unsupported_tool",
): ToolCallRegressionCaseResult {
  return {
    line,
    status: "skipped",
    recordStatus: identity.status,
    caseId: identity.caseId,
    toolName: identity.toolName,
    title: identity.title,
    skipReason,
    failures: [],
  };
}

function failure(
  line: number,
  identity: RegressionIdentity,
  path: string,
  expected: string,
  actual: string,
): ToolCallRegressionFailure {
  return {
    line,
    caseId: identity.caseId,
    toolName: identity.toolName,
    path,
    expected,
    actual,
  };
}

function readIdentity(value: unknown): RegressionIdentity {
  if (!isRecord(value)) return emptyIdentity();
  return {
    caseId: isPositiveInteger(value.id) ? value.id : null,
    toolName: isNonEmptyString(value.toolName) ? value.toolName : null,
    title: isNonEmptyString(value.title) ? value.title : null,
    status: isToolCallRegressionStatus(value.status) ? value.status : null,
  };
}

function emptyIdentity(): RegressionIdentity {
  return { caseId: null, toolName: null, title: null, status: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

function isPositiveIntegerOrNull(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isToolCallRegressionLabel(value: unknown): value is ToolCallRegressionCaseLabel {
  return typeof value === "string" && LABELS.has(value as ToolCallRegressionCaseLabel);
}

function isToolCallRegressionStatus(value: unknown): value is ToolCallRegressionCaseStatus {
  return typeof value === "string" && STATUSES.has(value as ToolCallRegressionCaseStatus);
}

function describeValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
