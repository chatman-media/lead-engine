import type { OperatorHandoffMeta } from "@chatman-media/channel-core";
import type { ExchangeResponseGuardFinding } from "@chatman-media/conversation-engine";
import {
  EXCHANGE_SELF_PLAY_SCENARIOS,
  type ExchangeScenarioFieldExpectation,
  type ExchangeSelfPlayScenario,
  type ExchangeSelfPlayScenarioTag,
  selectExchangeSelfPlayScenarios,
} from "./scenario-corpus.ts";

export type ExchangeLiveEvalMode = "deterministic_mock" | "live";

export interface ExchangeLiveEvalTurn {
  role: "user" | "assistant" | "human" | "system";
  text: string;
  stepIndex?: number;
}

export interface ExchangeLiveEvalActualOrder {
  status?: string | null;
  paymentMethod?: string | null;
  paymentRail?: string | null;
  payoutMethod?: string | null;
  payoutLocation?: string | null;
}

export interface ExchangeLiveEvalActualState {
  fields?: Record<string, unknown>;
  stages?: readonly string[];
  order?: ExchangeLiveEvalActualOrder | null;
  handoffs?: readonly OperatorHandoffMeta["reason"][];
  guardFindings?: readonly ExchangeResponseGuardFinding[];
}

export interface ExchangeLiveEvalReplayResult {
  scenarioId: string;
  mode: ExchangeLiveEvalMode;
  transcript: readonly ExchangeLiveEvalTurn[];
  actual: ExchangeLiveEvalActualState;
  error?: string;
}

export interface ExchangeLiveEvalFailure {
  kind:
    | "replay_error"
    | "field_missing"
    | "field_mismatch"
    | "stage_missing"
    | "order_mismatch"
    | "order_unexpected"
    | "handoff_missing"
    | "reply_assertion"
    | "guard_violation";
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ExchangeLiveEvalMetrics {
  fieldAccuracy: number;
  stageCoverage: number;
  orderCorrect: boolean;
  handoffCorrect: boolean;
  replyAssertionsPassed: boolean;
  guardViolationCount: number;
  score: number;
}

export interface ExchangeLiveEvalScenarioResult {
  scenarioId: string;
  title: string;
  tags: readonly ExchangeSelfPlayScenarioTag[];
  mode: ExchangeLiveEvalMode;
  passed: boolean;
  metrics: ExchangeLiveEvalMetrics;
  failures: readonly ExchangeLiveEvalFailure[];
  transcript: readonly ExchangeLiveEvalTurn[];
  expected: {
    fields: readonly ExchangeScenarioFieldExpectation[];
    stages: readonly string[];
    orderStatus?: string;
    handoffs: readonly OperatorHandoffMeta["reason"][];
  };
  actual: ExchangeLiveEvalActualState;
  debugHint: string;
}

export interface ExchangeLiveEvalReport {
  generatedAt: string;
  mode: ExchangeLiveEvalMode;
  total: number;
  passed: number;
  passRate: number;
  score: number;
  seed?: ExchangeLiveEvalSeedSnapshot;
  results: readonly ExchangeLiveEvalScenarioResult[];
}

export interface ExchangeLiveEvalSeedSnapshot {
  tenantId: number;
  tenantSlug: string;
  activeChannels: number;
  activeRates: number;
  exchangeResponseGuardEnabled: boolean;
}

export type ExchangeLiveEvalRunner = (
  scenario: ExchangeSelfPlayScenario,
) => Promise<ExchangeLiveEvalReplayResult> | ExchangeLiveEvalReplayResult;

function concreteFieldExpected(field: ExchangeScenarioFieldExpectation): boolean {
  return (
    field.value !== undefined ||
    field.oneOf !== undefined ||
    field.source === "tool" ||
    field.source === "operator" ||
    field.source === "fixture"
  );
}

function normalized(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().toLowerCase();
  return String(value).trim().toLowerCase();
}

function fieldMatches(field: ExchangeScenarioFieldExpectation, actual: unknown): boolean {
  if (actual === undefined || actual === null || actual === "") return false;
  if (field.value !== undefined) return normalized(actual) === normalized(field.value);
  if (field.oneOf) {
    const value = normalized(actual);
    return field.oneOf.some((item) => normalized(item) === value);
  }
  return true;
}

function scoreFields(
  scenario: ExchangeSelfPlayScenario,
  actual: ExchangeLiveEvalActualState,
): {
  accuracy: number;
  failures: ExchangeLiveEvalFailure[];
} {
  const expected = scenario.expectedFields.filter(
    (field) => field.required && concreteFieldExpected(field),
  );
  if (expected.length === 0) return { accuracy: 1, failures: [] };
  const fields = actual.fields ?? {};
  const failures: ExchangeLiveEvalFailure[] = [];
  let passed = 0;
  for (const field of expected) {
    const got = fields[field.key];
    if (got === undefined || got === null || got === "") {
      failures.push({
        kind: "field_missing",
        message: `Missing required field: ${field.key}`,
        expected: field,
        actual: got,
      });
      continue;
    }
    if (!fieldMatches(field, got)) {
      failures.push({
        kind: "field_mismatch",
        message: `Field mismatch: ${field.key}`,
        expected: field.value ?? field.oneOf,
        actual: got,
      });
      continue;
    }
    passed += 1;
  }
  return { accuracy: passed / expected.length, failures };
}

function scoreStages(
  scenario: ExchangeSelfPlayScenario,
  actual: ExchangeLiveEvalActualState,
): { coverage: number; failures: ExchangeLiveEvalFailure[] } {
  const expected = scenario.expectedStages;
  if (expected.length === 0) return { coverage: 1, failures: [] };
  const actualStages = new Set(actual.stages ?? []);
  const missing = expected.filter((stage) => !actualStages.has(stage));
  return {
    coverage: (expected.length - missing.length) / expected.length,
    failures: missing.map((stage) => ({
      kind: "stage_missing",
      message: `Missing expected stage: ${stage}`,
      expected: stage,
      actual: actual.stages ?? [],
    })),
  };
}

function scoreOrder(
  scenario: ExchangeSelfPlayScenario,
  actual: ExchangeLiveEvalActualState,
): { correct: boolean; failures: ExchangeLiveEvalFailure[] } {
  const expected = scenario.expectedOrder;
  const got = actual.order ?? null;
  if (!expected) {
    if (!got?.status) return { correct: true, failures: [] };
    return {
      correct: false,
      failures: [
        {
          kind: "order_unexpected",
          message: "Unexpected exchange order state",
          expected: null,
          actual: got,
        },
      ],
    };
  }
  const checks: Array<[keyof ExchangeLiveEvalActualOrder, string | undefined]> = [
    ["status", expected.status],
    ["paymentMethod", expected.paymentMethod],
    ["paymentRail", expected.paymentRail],
    ["payoutMethod", expected.payoutMethod],
    ["payoutLocation", expected.payoutLocation],
  ];
  const failures = checks
    .filter(([, value]) => value !== undefined)
    .filter(([key, value]) => normalized(got?.[key]) !== normalized(value))
    .map(([key, value]) => ({
      kind: "order_mismatch" as const,
      message: `Order mismatch: ${String(key)}`,
      expected: value,
      actual: got?.[key] ?? null,
    }));
  return { correct: failures.length === 0, failures };
}

function scoreHandoffs(
  scenario: ExchangeSelfPlayScenario,
  actual: ExchangeLiveEvalActualState,
): { correct: boolean; failures: ExchangeLiveEvalFailure[] } {
  const expected = scenario.expectedHandoffs;
  const actualSet = new Set(actual.handoffs ?? []);
  const missing = expected.filter((reason) => !actualSet.has(reason));
  return {
    correct: missing.length === 0,
    failures: missing.map((reason) => ({
      kind: "handoff_missing",
      message: `Missing expected operator handoff: ${reason}`,
      expected: reason,
      actual: actual.handoffs ?? [],
    })),
  };
}

function assistantText(transcript: readonly ExchangeLiveEvalTurn[]): string {
  return transcript
    .filter((turn) => turn.role === "assistant" || turn.role === "human")
    .map((turn) => turn.text.toLowerCase())
    .join("\n");
}

function scoreReplyAssertions(
  scenario: ExchangeSelfPlayScenario,
  transcript: readonly ExchangeLiveEvalTurn[],
): { passed: boolean; failures: ExchangeLiveEvalFailure[] } {
  const text = assistantText(transcript);
  const failures: ExchangeLiveEvalFailure[] = [];
  for (const assertion of scenario.criticalReplyAssertions) {
    if (
      assertion.mustIncludeAny &&
      !assertion.mustIncludeAny.some((item) => text.includes(item.toLowerCase()))
    ) {
      failures.push({
        kind: "reply_assertion",
        message: `Reply assertion failed: ${assertion.id} missing include token`,
        expected: assertion.mustIncludeAny,
        actual: text,
      });
    }
    for (const forbidden of assertion.mustNotIncludeAny ?? []) {
      if (text.includes(forbidden.toLowerCase())) {
        failures.push({
          kind: "reply_assertion",
          message: `Reply assertion failed: ${assertion.id} forbidden token "${forbidden}"`,
          expected: `not ${forbidden}`,
          actual: text,
        });
      }
    }
  }
  return { passed: failures.length === 0, failures };
}

function scoreGuardFindings(actual: ExchangeLiveEvalActualState): ExchangeLiveEvalFailure[] {
  return (actual.guardFindings ?? [])
    .filter((finding) => finding.action !== "pass")
    .map((finding) => ({
      kind: "guard_violation" as const,
      message: `Guard finding: ${finding.reasons.join(",") || finding.action}`,
      expected: "no response guard finding",
      actual: finding,
    }));
}

function computeScore(metrics: Omit<ExchangeLiveEvalMetrics, "score">): number {
  const orderScore = metrics.orderCorrect ? 1 : 0;
  const handoffScore = metrics.handoffCorrect ? 1 : 0;
  const replyScore = metrics.replyAssertionsPassed ? 1 : 0;
  const guardScore = metrics.guardViolationCount === 0 ? 1 : 0;
  return Number(
    (
      metrics.fieldAccuracy * 0.25 +
      metrics.stageCoverage * 0.25 +
      orderScore * 0.15 +
      handoffScore * 0.15 +
      replyScore * 0.1 +
      guardScore * 0.1
    ).toFixed(4),
  );
}

export function evaluateExchangeLiveReplay(
  scenario: ExchangeSelfPlayScenario,
  replay: ExchangeLiveEvalReplayResult,
): ExchangeLiveEvalScenarioResult {
  const fieldScore = scoreFields(scenario, replay.actual);
  const stageScore = scoreStages(scenario, replay.actual);
  const orderScore = scoreOrder(scenario, replay.actual);
  const handoffScore = scoreHandoffs(scenario, replay.actual);
  const replyScore = scoreReplyAssertions(scenario, replay.transcript);
  const guardFailures = scoreGuardFindings(replay.actual);
  const replayFailures: ExchangeLiveEvalFailure[] = replay.error
    ? [{ kind: "replay_error", message: replay.error }]
    : [];
  const failures = [
    ...replayFailures,
    ...fieldScore.failures,
    ...stageScore.failures,
    ...orderScore.failures,
    ...handoffScore.failures,
    ...replyScore.failures,
    ...guardFailures,
  ];
  const metricsWithoutScore = {
    fieldAccuracy: fieldScore.accuracy,
    stageCoverage: stageScore.coverage,
    orderCorrect: orderScore.correct,
    handoffCorrect: handoffScore.correct,
    replyAssertionsPassed: replyScore.passed,
    guardViolationCount: guardFailures.length,
  };
  const metrics: ExchangeLiveEvalMetrics = {
    ...metricsWithoutScore,
    score: computeScore(metricsWithoutScore),
  };
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    tags: scenario.tags,
    mode: replay.mode,
    passed: failures.length === 0 && metrics.score >= 1,
    metrics,
    failures,
    transcript: replay.transcript,
    expected: {
      fields: scenario.expectedFields,
      stages: scenario.expectedStages,
      ...(scenario.expectedOrder ? { orderStatus: scenario.expectedOrder.status } : {}),
      handoffs: scenario.expectedHandoffs,
    },
    actual: replay.actual,
    debugHint: scenario.debugHint,
  };
}

export async function runExchangeLiveEval(opts: {
  runner: ExchangeLiveEvalRunner;
  scenarioId?: string | null;
  now?: Date;
  seed?: ExchangeLiveEvalSeedSnapshot;
}): Promise<ExchangeLiveEvalReport> {
  const scenarios = selectExchangeSelfPlayScenarios(opts.scenarioId);
  const results: ExchangeLiveEvalScenarioResult[] = [];
  for (const scenario of scenarios) {
    const replay = await opts.runner(scenario);
    results.push(evaluateExchangeLiveReplay(scenario, replay));
  }
  const passed = results.filter((result) => result.passed).length;
  const score =
    results.length === 0
      ? 0
      : Number(
          (results.reduce((sum, result) => sum + result.metrics.score, 0) / results.length).toFixed(
            4,
          ),
        );
  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    mode: results[0]?.mode ?? "deterministic_mock",
    total: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    score,
    ...(opts.seed ? { seed: opts.seed } : {}),
    results,
  };
}

function mockAssistantReply(scenario: ExchangeSelfPlayScenario): string {
  if (scenario.id === "rub-office-pickup-payment-proof") {
    return "Чек получил, передаю оператору на проверку. Выдача в офисе Bangkok Asok будет после проверки.";
  }
  if (scenario.id === "usdt-trc20-cash-delivery") {
    return "Адрес кошелька TRC20 выдан из системы. После перевода пришлите tx hash.";
  }
  if (scenario.id === "usdt-to-thai-bank-transfer") {
    return "Получил реквизиты Bangkok Bank и счет. Подготовлю адрес для оплаты.";
  }
  if (scenario.id === "rate-first-then-amount-network-change") {
    return "Пересчитал заявку на 2500 USDT через Binance ID.";
  }
  if (scenario.id === "missing-required-fields") {
    return "Уточните валюту, сумму, как хотите получить и способ перевода.";
  }
  if (scenario.id === "kyc-media-verification") {
    return "Материалы для верификации принял, передаю оператору на проверку.";
  }
  if (scenario.id === "fiat-payment-proof-review") {
    return "Чек получил, передаю оператору на проверку. Перевод на Bangkok Bank будет после проверки.";
  }
  if (scenario.id === "unsupported-city-out-of-hours") {
    return "Город и время нужно уточнить у оператора.";
  }
  if (scenario.id === "rate-stale-limit-cancelled") {
    return "Нужна актуальная котировка, сумма ниже минимума, заявку отменил.";
  }
  return "Принял данные, продолжаю по workflow.";
}

function mockFieldValue(field: ExchangeScenarioFieldExpectation): unknown {
  if (field.value !== undefined) return field.value;
  if (field.oneOf?.length) return field.oneOf[0];
  if (field.source === "fixture") return true;
  if (field.source === "tool") return "tool_result";
  if (field.source === "operator") return "operator_confirmed";
  return undefined;
}

export function buildDeterministicExchangeReplay(
  scenario: ExchangeSelfPlayScenario,
): ExchangeLiveEvalReplayResult {
  const transcript: ExchangeLiveEvalTurn[] = [];
  scenario.clientScript.forEach((text, index) => {
    transcript.push({ role: "user", text, stepIndex: index });
  });
  transcript.push({
    role: "assistant",
    text: mockAssistantReply(scenario),
    stepIndex: scenario.clientScript.length,
  });
  const fields: Record<string, unknown> = {};
  for (const field of scenario.expectedFields) {
    const value = mockFieldValue(field);
    if (value !== undefined) fields[field.key] = value;
  }
  return {
    scenarioId: scenario.id,
    mode: "deterministic_mock",
    transcript,
    actual: {
      fields,
      stages: scenario.expectedStages,
      order: scenario.expectedOrder ?? null,
      handoffs: scenario.expectedHandoffs,
      guardFindings: [],
    },
  };
}

export function createDeterministicExchangeLiveEvalRunner(): ExchangeLiveEvalRunner {
  return (scenario) => buildDeterministicExchangeReplay(scenario);
}

export function formatExchangeLiveEvalSummary(report: ExchangeLiveEvalReport): string {
  const lines = [
    `Exchange live eval: ${report.passed}/${report.total} passed (${(report.passRate * 100).toFixed(1)}%), score=${(report.score * 100).toFixed(1)}%`,
  ];
  if (report.seed) {
    lines.push(
      `seed tenant=${report.seed.tenantSlug} channels=${report.seed.activeChannels} rates=${report.seed.activeRates} guard=${report.seed.exchangeResponseGuardEnabled ? "on" : "off"}`,
    );
  }
  for (const result of report.results) {
    const status = result.passed ? "pass" : "fail";
    lines.push(
      `- ${status} ${result.scenarioId} score=${(result.metrics.score * 100).toFixed(1)}% fields=${(result.metrics.fieldAccuracy * 100).toFixed(0)}% stages=${(result.metrics.stageCoverage * 100).toFixed(0)}% handoffs=${result.metrics.handoffCorrect ? "ok" : "fail"} guard=${result.metrics.guardViolationCount}`,
    );
    for (const failure of result.failures.slice(0, 5)) {
      lines.push(`  - ${failure.kind}: ${failure.message}`);
    }
  }
  return lines.join("\n");
}

export { EXCHANGE_SELF_PLAY_SCENARIOS };
