import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { ActivePhase } from "@chatman-media/verticals";
import { type SeedStage, validateFunnel } from "../routes/admin-funnel.ts";
import { normalizeStages, type StageDraft, SYSTEM_PROMPT } from "../routes/admin-workflow.ts";

export interface FunnelEvalScenario {
  id: string;
  name: string;
  description: string;
  expect: {
    multiRequest?: boolean;
    requestTypes?: string[];
    requiredPhases?: ActivePhase[];
    fieldKeywords?: string[];
  };
}

export interface FunnelEvalMetrics {
  structuralValid: boolean;
  branchValid: boolean;
  phaseCoverage: number;
  fieldQuality: number;
  behaviorCoverage: number;
  stageCount: number;
  activeStageCount: number;
}

export interface FunnelEvalResult {
  scenarioId: string;
  scenarioName: string;
  passed: boolean;
  retryCount: number;
  metrics: FunnelEvalMetrics;
  errors: string[];
  warnings: string[];
  rawPreview: string;
  stages: SeedStage[];
}

export interface FunnelEvalReport {
  generatedAt: string;
  total: number;
  passed: number;
  validityRate: number;
  results: FunnelEvalResult[];
}

export const DEFAULT_FUNNEL_EVAL_SCENARIOS: readonly FunnelEvalScenario[] = [
  {
    id: "linear-school",
    name: "Linear service funnel",
    description:
      "Онлайн-школа английского. Лиды пишут в Telegram, нужно понять цель и уровень, записать на пробный урок, потом продать пакет занятий и довести до оплаты.",
    expect: {
      requiredPhases: ["qualify", "offer"],
      fieldKeywords: ["имя", "цель", "уров", "время", "оплат"],
    },
  },
  {
    id: "exchange-clear-fulfill",
    name: "Exchange with clear and fulfill",
    description:
      "Криптообменник на Пхукете: клиент меняет USDT/BTC/RUB на THB. Нужно собрать направление, сумму, сеть, посчитать курс, проверить KYC/AML, выдать реквизиты, проверить оплату и выдать баты в офисе или через банкомат.",
    expect: {
      requiredPhases: ["qualify", "offer", "clear", "fulfill"],
      fieldKeywords: ["сумм", "валют", "сеть", "kyc", "aml", "оплат"],
    },
  },
  {
    id: "concierge-multi-request",
    name: "Concierge multi-request funnel",
    description:
      "Вилла с консьержем: один гость может параллельно заказать трансфер, еду, уборку или экскурсию. Бот должен определить тип запроса, вести каждую услугу отдельно, цену часто подтверждает оператор.",
    expect: {
      multiRequest: true,
      requestTypes: ["transfer", "food", "housekeeping", "tour"],
      requiredPhases: ["qualify", "offer"],
      fieldKeywords: ["request_type", "трансфер", "еда", "уборк", "экскурс"],
    },
  },
];

export function buildFunnelEvalMessages(scenario: FunnelEvalScenario): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `${scenario.description}\n\n` +
        "Собери воронку сразу, если данных достаточно. Верни только JSON.",
    },
  ];
}

export function parseFunnelBuilderOutput(raw: string): {
  reply: string;
  stages: SeedStage[];
  parseError?: string;
} {
  const candidate = extractJsonObject(raw);
  if (!candidate) {
    return { reply: "", stages: [], parseError: "no JSON object found" };
  }
  try {
    const parsed = JSON.parse(candidate) as {
      reply?: unknown;
      stages?: unknown;
    };
    if (!Array.isArray(parsed.stages)) {
      return {
        reply: stringValue(parsed.reply),
        stages: [],
        parseError: "stages array missing",
      };
    }
    return {
      reply: stringValue(parsed.reply),
      stages: normalizeStages(parsed.stages as StageDraft[]),
    };
  } catch (err) {
    return {
      reply: "",
      stages: [],
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

export function scoreFunnelOutput(
  scenario: FunnelEvalScenario,
  raw: string,
  retryCount = 0,
): FunnelEvalResult {
  const parsed = parseFunnelBuilderOutput(raw);
  const backbone =
    parsed.stages.length > 0 ? validateFunnel(parsed.stages) : { errors: [], warnings: [] };
  const parseErrors = parsed.parseError ? [`Parse: ${parsed.parseError}`] : [];
  const phases = new Set(
    parsed.stages
      .map((stage) => stage.phase)
      .filter((phase): phase is ActivePhase => Boolean(phase)),
  );
  const requiredPhases = scenario.expect.requiredPhases ?? [];
  const phaseHits = requiredPhases.filter((phase) => phases.has(phase)).length;
  const phaseCoverage = requiredPhases.length === 0 ? 1 : phaseHits / requiredPhases.length;
  const branchValid = branchContractValid(scenario, parsed.stages);
  const fieldQuality = scoreFieldKeywords(parsed.stages, scenario.expect.fieldKeywords ?? []);
  const activeStages = parsed.stages.filter((stage) => stage.kind === "active");
  const behaviorCoverage =
    activeStages.length === 0
      ? 0
      : activeStages.filter((stage) => stage.goal?.trim() && stage.guidance?.trim()).length /
        activeStages.length;
  const structuralValid =
    parsed.stages.length > 0 && !parsed.parseError && backbone.errors.length === 0;
  const metrics: FunnelEvalMetrics = {
    structuralValid,
    branchValid,
    phaseCoverage,
    fieldQuality,
    behaviorCoverage,
    stageCount: parsed.stages.length,
    activeStageCount: activeStages.length,
  };
  const errors = [
    ...parseErrors,
    ...backbone.errors,
    ...(branchValid ? [] : ["Branch contract failed"]),
    ...(phaseCoverage >= 1 ? [] : ["Required phase coverage failed"]),
    ...(fieldQuality >= 0.5 ? [] : ["Field quality below threshold"]),
    ...(behaviorCoverage >= 0.5 ? [] : ["Goal/guidance coverage below threshold"]),
  ];
  const passed =
    structuralValid &&
    branchValid &&
    phaseCoverage >= 1 &&
    fieldQuality >= 0.5 &&
    behaviorCoverage >= 0.5;

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    passed,
    retryCount,
    metrics,
    errors,
    warnings: backbone.warnings,
    rawPreview: raw.slice(0, 4000),
    stages: parsed.stages,
  };
}

export async function runLiveFunnelEval(opts: {
  chat: ChatClient;
  scenarios?: readonly FunnelEvalScenario[];
  maxRetries?: number;
  now?: Date;
}): Promise<FunnelEvalReport> {
  const scenarios = opts.scenarios ?? DEFAULT_FUNNEL_EVAL_SCENARIOS;
  const maxRetries = opts.maxRetries ?? 1;
  const results: FunnelEvalResult[] = [];

  for (const scenario of scenarios) {
    let messages = buildFunnelEvalMessages(scenario);
    let final: FunnelEvalResult | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const raw = await opts.chat.complete(messages, {
        numPredict: 5000,
        temperature: attempt === 0 ? 0.2 : 0.1,
      });
      final = scoreFunnelOutput(scenario, raw, attempt);
      if (final.passed || attempt === maxRetries) break;
      messages = [
        ...messages,
        { role: "assistant", content: raw },
        {
          role: "user",
          content:
            "Исправь воронку и верни только валидный JSON. Ошибки:\n" +
            final.errors.map((error) => `- ${error}`).join("\n"),
        },
      ];
    }
    if (final) results.push(final);
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    total: results.length,
    passed,
    validityRate: results.length === 0 ? 0 : passed / results.length,
    results,
  };
}

export function formatFunnelEvalSummary(report: FunnelEvalReport): string {
  const lines = [
    `AI Funnel Builder live eval: ${report.passed}/${report.total} passed (${(report.validityRate * 100).toFixed(1)}%)`,
  ];
  for (const result of report.results) {
    const status = result.passed ? "pass" : "fail";
    lines.push(
      [
        `- ${result.scenarioId}`,
        status,
        `retries=${result.retryCount}`,
        `stages=${result.metrics.stageCount}`,
        `fields=${result.metrics.fieldQuality.toFixed(2)}`,
        `behavior=${result.metrics.behaviorCoverage.toFixed(2)}`,
      ].join(" "),
    );
    if (!result.passed) {
      lines.push(`  errors: ${result.errors.join("; ")}`);
    }
  }
  return lines.join("\n");
}

function extractJsonObject(raw: string): string | null {
  const stripped = raw.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return stripped.slice(start, end + 1);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function branchContractValid(scenario: FunnelEvalScenario, stages: SeedStage[]): boolean {
  if (!scenario.expect.multiRequest) return true;
  const intake = stages.find((stage) => stage.kind === "intake");
  const requestType = intake?.fields.find((field) => field.slug === "request_type");
  if (!intake || !requestType) return false;
  const branchSlugs = new Set(intake.nextStages ?? []);
  for (const type of scenario.expect.requestTypes ?? []) {
    const hasBranch = [...branchSlugs].some(
      (slug) => slug === `${type}_request` || slug.startsWith(`${type}_`),
    );
    if (!hasBranch) return false;
  }
  return true;
}

function scoreFieldKeywords(stages: SeedStage[], keywords: readonly string[]): number {
  if (keywords.length === 0) return 1;
  const haystack = stages
    .flatMap((stage) => [
      stage.slug,
      stage.displayName,
      stage.goal ?? "",
      stage.guidance ?? "",
      ...stage.fields.flatMap((field) => [
        field.slug,
        field.displayName,
        field.hint ?? "",
        field.optionsJson ?? "",
      ]),
    ])
    .join(" ")
    .toLowerCase();
  const hits = keywords.filter((keyword) => haystack.includes(keyword.toLowerCase())).length;
  return hits / keywords.length;
}
