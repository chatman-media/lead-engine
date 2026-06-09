import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { answerWithRag } from "./answer.ts";
import type { AnswerInput, AnswerResult, AnswerTelemetry } from "./answer-types.ts";
import type { KbSearchHit } from "./types.ts";

export interface RagGoldenCase {
  id: string;
  question: string;
  history?: ChatMessage[];
  expectedSources?: string[];
  expectedFacts?: string[];
  forbiddenFacts?: string[];
  personaExpectations?: string[];
  answerIncludes?: string[];
  answerExcludes?: string[];
  expectedPath?: AnswerTelemetry["path"];
  minRetrievalRecall?: number;
  minGroundedness?: number;
  minPersonaConsistency?: number;
  maxForbiddenViolations?: number;
  metadata?: Record<string, unknown>;
}

export interface RagGoldenThresholds {
  minRetrievalRecall?: number;
  minGroundedness?: number;
  minPersonaConsistency?: number;
  maxForbiddenViolations?: number;
}

export interface RagGoldenAblation {
  id: string;
  label?: string;
  mutateInput: (input: AnswerInput, item: RagGoldenCase) => AnswerInput | Promise<AnswerInput>;
}

export interface RagGoldenMakeInputContext {
  variantId: string;
  ablationId?: string;
}

export interface RagGoldenRunInput {
  cases: RagGoldenCase[];
  makeInput: (
    item: RagGoldenCase,
    context: RagGoldenMakeInputContext,
  ) => AnswerInput | Promise<AnswerInput>;
  ablations?: RagGoldenAblation[];
  judge?: RagGoldenJudge;
  thresholds?: RagGoldenThresholds;
  metadata?: Record<string, unknown>;
}

export interface RagGoldenMetrics {
  retrievalRecall: number;
  groundedness: number;
  personaConsistency: number;
  forbiddenViolations: number;
}

export interface RagGoldenFailure {
  caseId: string;
  variantId: string;
  expected: string;
  actual: string;
}

export interface RagGoldenJudgeInput {
  item: RagGoldenCase;
  answer: AnswerResult;
  variantId: string;
  deterministicMetrics: RagGoldenMetrics;
}

export interface RagGoldenJudgeResult {
  groundedness?: number;
  personaConsistency?: number;
  forbiddenViolations?: number;
  notes?: string[];
}

export type RagGoldenJudge = (
  input: RagGoldenJudgeInput,
) => RagGoldenJudgeResult | Promise<RagGoldenJudgeResult>;

export interface RagGoldenCaseResult {
  caseId: string;
  variantId: string;
  passed: boolean;
  metrics: RagGoldenMetrics;
  failures: RagGoldenFailure[];
  judgeNotes?: string[];
  answer: string;
  usedChunkIds: number[];
  hitSources: string[];
  telemetry: AnswerTelemetry;
}

export interface RagGoldenVariantSummary {
  variantId: string;
  label: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  meanRetrievalRecall: number;
  meanGroundedness: number;
  meanPersonaConsistency: number;
  forbiddenViolations: number;
  pathCounts: Record<string, number>;
}

export interface RagGoldenReport {
  generatedAt: string;
  metadata?: Record<string, unknown>;
  variants: RagGoldenVariantSummary[];
  results: RagGoldenCaseResult[];
}

export interface RagGoldenReportDelta {
  variantId: string;
  passRateDelta: number;
  retrievalRecallDelta: number;
  groundednessDelta: number;
  personaConsistencyDelta: number;
}

type RagGoldenVariant = {
  id: string;
  label: string;
  ablationId?: string;
  mutateInput?: RagGoldenAblation["mutateInput"];
};

const DEFAULT_THRESHOLDS: Required<RagGoldenThresholds> = {
  minRetrievalRecall: 1,
  minGroundedness: 1,
  minPersonaConsistency: 1,
  maxForbiddenViolations: 0,
};

export function parseRagGoldenJsonl(raw: string): RagGoldenCase[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as RagGoldenCase);
}

export async function evaluateRagGoldenCases(input: RagGoldenRunInput): Promise<RagGoldenReport> {
  const variants: RagGoldenVariant[] = [
    { id: "baseline", label: "Baseline" },
    ...(input.ablations ?? []).map((ablation) => ({
      id: ablation.id,
      label: ablation.label ?? ablation.id,
      ablationId: ablation.id,
      mutateInput: ablation.mutateInput,
    })),
  ];

  const results: RagGoldenCaseResult[] = [];
  for (const item of input.cases) {
    for (const variant of variants) {
      results.push(await evaluateVariant(item, variant, input));
    }
  }

  const report: RagGoldenReport = {
    generatedAt: new Date().toISOString(),
    variants: summarizeVariants(results, variants),
    results,
  };
  if (input.metadata) report.metadata = input.metadata;
  return report;
}

export function defaultRagGoldenAblations(): RagGoldenAblation[] {
  return [
    {
      id: "no_rewrite",
      label: "No query rewrite",
      mutateInput: (input) => ({ ...input, rewriteQueryBeforeRetrieval: false }),
    },
    {
      id: "no_multi_query",
      label: "No multi-query",
      mutateInput: (input) => ({ ...input, multiQuery: false }),
    },
    {
      id: "no_hybrid",
      label: "Vector only",
      mutateInput: (input) => ({ ...input, hybridSearch: false }),
    },
    {
      id: "no_topic_routing",
      label: "No topic routing",
      mutateInput: (input) => ({ ...input, topicRouting: false }),
    },
    {
      id: "no_mmr",
      label: "No MMR",
      mutateInput: (input) => ({ ...input, mmr: false }),
    },
    {
      id: "no_reranker",
      label: "No reranker",
      mutateInput: (input) => {
        const { reranker: _reranker, ...withoutReranker } = input;
        return withoutReranker;
      },
    },
    {
      id: "no_reflect",
      label: "No reflection",
      mutateInput: (input) => ({ ...input, reflect: false }),
    },
  ];
}

export function formatRagGoldenFailures(report: RagGoldenReport): string {
  const failures = report.results.flatMap((result) => result.failures);
  if (failures.length === 0) return "";
  return failures
    .map((failure) =>
      [
        `case=${failure.caseId}`,
        `variant=${failure.variantId}`,
        `expected=${failure.expected}`,
        `actual=${failure.actual}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function compareRagGoldenReports(
  current: RagGoldenReport,
  baseline: RagGoldenReport,
): RagGoldenReportDelta[] {
  const baselineByVariant = new Map(
    baseline.variants.map((variant) => [variant.variantId, variant]),
  );
  return current.variants.map((variant) => {
    const previous = baselineByVariant.get(variant.variantId);
    return {
      variantId: variant.variantId,
      passRateDelta: variant.passRate - (previous?.passRate ?? 0),
      retrievalRecallDelta: variant.meanRetrievalRecall - (previous?.meanRetrievalRecall ?? 0),
      groundednessDelta: variant.meanGroundedness - (previous?.meanGroundedness ?? 0),
      personaConsistencyDelta:
        variant.meanPersonaConsistency - (previous?.meanPersonaConsistency ?? 0),
    };
  });
}

export function makeRagGoldenLlmJudge(input: { chat: ChatClient }): RagGoldenJudge {
  return async ({ item, answer, deterministicMetrics }) => {
    const sourceSnippets = answer.hits
      .slice(0, 5)
      .map((hit, index) => `[#${index + 1}] ${hit.title} (${hit.source})\n${hit.text}`)
      .join("\n\n");

    const raw = await input.chat.complete(
      [
        {
          role: "system",
          content: [
            "You judge RAG answer quality. Return JSON only.",
            "groundedness and personaConsistency are numbers from 0 to 1.",
            "forbiddenViolations is a non-negative integer.",
            "Do not reward facts that are unsupported by the provided source snippets.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            question: item.question,
            expectedFacts: item.expectedFacts ?? [],
            forbiddenFacts: [...(item.forbiddenFacts ?? []), ...(item.answerExcludes ?? [])],
            personaExpectations: item.personaExpectations ?? [],
            answer: answer.text,
            sourceSnippets,
            deterministicMetrics,
          }),
        },
      ],
      { temperature: 0 },
    );

    return parseRagGoldenJudgeResult(raw);
  };
}

export function parseRagGoldenJudgeResult(raw: string): RagGoldenJudgeResult {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return {};

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return {
      ...(typeof parsed.groundedness === "number"
        ? { groundedness: clamp01(parsed.groundedness) }
        : {}),
      ...(typeof parsed.personaConsistency === "number"
        ? { personaConsistency: clamp01(parsed.personaConsistency) }
        : {}),
      ...(typeof parsed.forbiddenViolations === "number"
        ? { forbiddenViolations: Math.max(0, Math.trunc(parsed.forbiddenViolations)) }
        : {}),
      ...(Array.isArray(parsed.notes)
        ? { notes: parsed.notes.filter((note): note is string => typeof note === "string") }
        : {}),
    };
  } catch {
    return {};
  }
}

async function evaluateVariant(
  item: RagGoldenCase,
  variant: RagGoldenVariant,
  run: RagGoldenRunInput,
): Promise<RagGoldenCaseResult> {
  const context: RagGoldenMakeInputContext = {
    variantId: variant.id,
    ...(variant.ablationId ? { ablationId: variant.ablationId } : {}),
  };
  const baseInput = await run.makeInput(item, context);
  const answerInput = variant.mutateInput ? await variant.mutateInput(baseInput, item) : baseInput;

  let answer: AnswerResult;
  try {
    answer = await answerWithRag(answerInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      caseId: item.id,
      variantId: variant.id,
      passed: false,
      metrics: {
        retrievalRecall: 0,
        groundedness: 0,
        personaConsistency: 0,
        forbiddenViolations: 0,
      },
      failures: [
        {
          caseId: item.id,
          variantId: variant.id,
          expected: "answerWithRag completes",
          actual: message,
        },
      ],
      answer: "",
      usedChunkIds: [],
      hitSources: [],
      telemetry: { path: "no_context" },
    };
  }

  const { metrics, judgeNotes } = await scoreRagGoldenCase(item, answer, variant.id, run.judge);
  const failures = collectFailures(item, variant.id, answer, metrics, run.thresholds);

  return {
    caseId: item.id,
    variantId: variant.id,
    passed: failures.length === 0,
    metrics,
    failures,
    ...(judgeNotes.length > 0 ? { judgeNotes } : {}),
    answer: answer.text,
    usedChunkIds: answer.usedChunkIds,
    hitSources: hitSources(answer.hits),
    telemetry: answer.telemetry,
  };
}

async function scoreRagGoldenCase(
  item: RagGoldenCase,
  answer: AnswerResult,
  variantId: string,
  judge: RagGoldenJudge | undefined,
): Promise<{ metrics: RagGoldenMetrics; judgeNotes: string[] }> {
  const expectedSources = item.expectedSources ?? [];
  const expectedFacts = item.expectedFacts ?? [];
  const personaExpectations = item.personaExpectations ?? [];
  const forbiddenFacts = [...(item.forbiddenFacts ?? []), ...(item.answerExcludes ?? [])];

  const deterministicMetrics: RagGoldenMetrics = {
    retrievalRecall: fractionFound(expectedSources, (source) =>
      hitMatchesSource(answer.hits, source),
    ),
    groundedness: fractionFound(expectedFacts, (fact) => textIncludes(answer.text, fact)),
    personaConsistency: fractionFound(personaExpectations, (fact) =>
      textIncludes(answer.text, fact),
    ),
    forbiddenViolations: forbiddenFacts.filter((fact) => textIncludes(answer.text, fact)).length,
  };

  if (!judge) return { metrics: deterministicMetrics, judgeNotes: [] };

  const judged = await judge({ item, answer, variantId, deterministicMetrics });
  return {
    metrics: {
      ...deterministicMetrics,
      ...(judged.groundedness !== undefined ? { groundedness: clamp01(judged.groundedness) } : {}),
      ...(judged.personaConsistency !== undefined
        ? { personaConsistency: clamp01(judged.personaConsistency) }
        : {}),
      ...(judged.forbiddenViolations !== undefined
        ? { forbiddenViolations: Math.max(0, Math.trunc(judged.forbiddenViolations)) }
        : {}),
    },
    judgeNotes: judged.notes ?? [],
  };
}

function collectFailures(
  item: RagGoldenCase,
  variantId: string,
  answer: AnswerResult,
  metrics: RagGoldenMetrics,
  thresholds: RagGoldenThresholds | undefined,
): RagGoldenFailure[] {
  const effective = {
    ...DEFAULT_THRESHOLDS,
    ...(thresholds ?? {}),
    ...(item.minRetrievalRecall !== undefined
      ? { minRetrievalRecall: item.minRetrievalRecall }
      : {}),
    ...(item.minGroundedness !== undefined ? { minGroundedness: item.minGroundedness } : {}),
    ...(item.minPersonaConsistency !== undefined
      ? { minPersonaConsistency: item.minPersonaConsistency }
      : {}),
    ...(item.maxForbiddenViolations !== undefined
      ? { maxForbiddenViolations: item.maxForbiddenViolations }
      : {}),
  };
  const failures: RagGoldenFailure[] = [];
  const fail = (expected: string, actual: string) => {
    failures.push({ caseId: item.id, variantId, expected, actual });
  };

  if (metrics.retrievalRecall < effective.minRetrievalRecall) {
    fail(
      `retrievalRecall >= ${effective.minRetrievalRecall}`,
      `${metrics.retrievalRecall.toFixed(3)}; hits=${hitSources(answer.hits).join(", ")}`,
    );
  }
  if (metrics.groundedness < effective.minGroundedness) {
    const missing = (item.expectedFacts ?? []).filter((fact) => !textIncludes(answer.text, fact));
    fail(`groundedness >= ${effective.minGroundedness}`, `missing facts: ${missing.join(", ")}`);
  }
  if (metrics.personaConsistency < effective.minPersonaConsistency) {
    const missing = (item.personaExpectations ?? []).filter(
      (fact) => !textIncludes(answer.text, fact),
    );
    fail(
      `personaConsistency >= ${effective.minPersonaConsistency}`,
      `missing persona expectations: ${missing.join(", ")}`,
    );
  }
  if (metrics.forbiddenViolations > effective.maxForbiddenViolations) {
    const forbidden = [...(item.forbiddenFacts ?? []), ...(item.answerExcludes ?? [])].filter(
      (fact) => textIncludes(answer.text, fact),
    );
    fail(
      `forbiddenViolations <= ${effective.maxForbiddenViolations}`,
      `forbidden text present: ${forbidden.join(", ")}`,
    );
  }
  for (const expected of item.answerIncludes ?? []) {
    if (!textIncludes(answer.text, expected)) {
      fail(`answer includes "${expected}"`, summarizeText(answer.text));
    }
  }
  if (item.expectedPath && answer.telemetry.path !== item.expectedPath) {
    fail(`telemetry.path=${item.expectedPath}`, answer.telemetry.path);
  }

  return failures;
}

function summarizeVariants(
  results: RagGoldenCaseResult[],
  variants: RagGoldenVariant[],
): RagGoldenVariantSummary[] {
  return variants.map((variant) => {
    const byVariant = results.filter((result) => result.variantId === variant.id);
    const total = byVariant.length;
    const passed = byVariant.filter((result) => result.passed).length;
    return {
      variantId: variant.id,
      label: variant.label,
      total,
      passed,
      failed: total - passed,
      passRate: total === 0 ? 0 : passed / total,
      meanRetrievalRecall: mean(byVariant.map((result) => result.metrics.retrievalRecall)),
      meanGroundedness: mean(byVariant.map((result) => result.metrics.groundedness)),
      meanPersonaConsistency: mean(byVariant.map((result) => result.metrics.personaConsistency)),
      forbiddenViolations: byVariant.reduce(
        (sum, result) => sum + result.metrics.forbiddenViolations,
        0,
      ),
      pathCounts: countPaths(byVariant),
    };
  });
}

function fractionFound(expectations: string[], isFound: (value: string) => boolean): number {
  if (expectations.length === 0) return 1;
  const found = expectations.filter(isFound).length;
  return found / expectations.length;
}

function hitMatchesSource(hits: KbSearchHit[], expected: string): boolean {
  const needle = normalize(expected);
  return hits.some((hit) =>
    [
      String(hit.chunk_id),
      String(hit.document_id),
      hit.source,
      hit.title,
      hit.text,
      `${hit.title} ${hit.source}`,
    ].some((value) => normalize(value).includes(needle)),
  );
}

function hitSources(hits: KbSearchHit[]): string[] {
  return hits.map((hit) => {
    const title = hit.title.trim() || `chunk:${hit.chunk_id}`;
    const source = hit.source.trim();
    return source ? `${title} (${source})` : title;
  });
}

function textIncludes(text: string, expected: string): boolean {
  return normalize(text).includes(normalize(expected));
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countPaths(results: RagGoldenCaseResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.telemetry.path] = (counts[result.telemetry.path] ?? 0) + 1;
  }
  return counts;
}

function summarizeText(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function extractJsonObject(raw: string): string | null {
  const cleaned = stripThinkBlocks(raw)
    .replaceAll("```json", "")
    .replaceAll("```JSON", "")
    .replaceAll("```", "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

function stripThinkBlocks(raw: string): string {
  let rest = raw;
  let output = "";
  const openTag = "<think>";
  const closeTag = "</think>";

  while (rest.length > 0) {
    const lower = rest.toLocaleLowerCase();
    const start = lower.indexOf(openTag);
    if (start === -1) return output + rest;

    output += rest.slice(0, start);
    const close = lower.indexOf(closeTag, start + openTag.length);
    if (close === -1) return output;
    rest = rest.slice(close + closeTag.length);
  }

  return output;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
