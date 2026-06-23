import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseExchangeGoldenJsonl } from "./golden-eval.ts";
import {
  EXCHANGE_SELF_PLAY_SCENARIOS,
  type ExchangeSelfPlayScenario,
  type ExchangeSelfPlayScenarioTag,
  formatExchangeSelfPlayScenarioReport,
  runExchangeSelfPlayScenarioCorpus,
  selectExchangeSelfPlayScenarios,
} from "./scenario-corpus.ts";

const fixturesPath = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "apps",
  "vertical-exchange",
  "evals",
  "exchange-workflows.jsonl",
);

function loadCases() {
  return parseExchangeGoldenJsonl(readFileSync(fixturesPath, "utf8"));
}

function corpusTags(): Set<ExchangeSelfPlayScenarioTag> {
  return new Set(EXCHANGE_SELF_PLAY_SCENARIOS.flatMap((scenario) => scenario.tags));
}

describe("exchange self-play scenario corpus", () => {
  it("defines deterministic scenarios with fields, stages, assertions and debug hints", () => {
    expect(EXCHANGE_SELF_PLAY_SCENARIOS.length).toBeGreaterThanOrEqual(8);
    const ids = new Set<string>();

    for (const scenario of EXCHANGE_SELF_PLAY_SCENARIOS) {
      expect(ids.has(scenario.id)).toBe(false);
      ids.add(scenario.id);
      expect(scenario.title.length).toBeGreaterThan(0);
      expect(scenario.clientScript.length).toBeGreaterThan(0);
      expect(scenario.expectedWorkflow.length).toBeGreaterThan(0);
      expect(scenario.expectedFields.some((field) => field.required)).toBe(true);
      expect(scenario.expectedStages.length).toBeGreaterThan(0);
      expect(scenario.criticalReplyAssertions.length).toBeGreaterThan(0);
      expect(scenario.debugHint.length).toBeGreaterThan(0);
    }
  });

  it("covers the important money-flow branches", () => {
    const tags = corpusTags();
    for (const tag of [
      "rub",
      "usdt",
      "office_pickup",
      "cash",
      "thai_bank_transfer",
      "cardless_atm",
      "kyc",
      "media",
      "payment_proof",
      "missing_fields",
      "rate_change",
      "exception",
    ] satisfies ExchangeSelfPlayScenarioTag[]) {
      expect(tags.has(tag)).toBe(true);
    }
  });

  it("pins operator handoff branches that must not be auto-completed", () => {
    const byId = new Map(EXCHANGE_SELF_PLAY_SCENARIOS.map((scenario) => [scenario.id, scenario]));

    expect(byId.get("kyc-media-verification")?.expectedHandoffs).toContain("kyc_review");
    expect(byId.get("fiat-payment-proof-review")?.expectedHandoffs).toContain("payment_review");
    expect(byId.get("rub-office-pickup-payment-proof")?.expectedHandoffs).toContain(
      "payment_review",
    );
    expect(byId.get("rub-office-pickup-payment-proof")?.expectedHandoffs).toContain(
      "office_payout",
    );
    expect(byId.get("unsupported-city-out-of-hours")?.expectedHandoffs).toContain(
      "operator_request",
    );
  });

  it("selects one scenario or reports available scenario ids", () => {
    expect(selectExchangeSelfPlayScenarios("fiat-payment-proof-review")).toHaveLength(1);
    expect(() => selectExchangeSelfPlayScenarios("unknown")).toThrow(
      /Available: .*fiat-payment-proof-review/,
    );
  });

  it("validates fixture links and can run the whole corpus", () => {
    const report = runExchangeSelfPlayScenarioCorpus({
      fixtureCases: loadCases(),
    });
    expect(report.ok).toBe(true);
    expect(report.failures).toHaveLength(0);
    expect(report.total).toBe(EXCHANGE_SELF_PLAY_SCENARIOS.length);
    expect(report.scenarios.some((scenario) => scenario.sourceFixtureId)).toBe(true);
  });

  it("can run a single scenario", () => {
    const report = runExchangeSelfPlayScenarioCorpus({
      scenarioId: "rub-office-pickup-payment-proof",
      fixtureCases: loadCases(),
    });
    expect(report.ok).toBe(true);
    expect(report.total).toBe(1);
    expect(report.scenarios[0]?.id).toBe("rub-office-pickup-payment-proof");
    expect(report.scenarios[0]?.expectedOrderStatus).toBe("payout");
  });

  it("formats a readable corpus report for CLI and CI logs", () => {
    const report = runExchangeSelfPlayScenarioCorpus({
      scenarioId: "rub-office-pickup-payment-proof",
      fixtureCases: loadCases(),
    });
    const formatted = formatExchangeSelfPlayScenarioReport(report);

    expect(formatted).toContain("exchange self-play corpus: ok");
    expect(formatted).toContain("rub-office-pickup-payment-proof");
    expect(formatted).toContain("tags=rub,office_pickup,payment_proof");
    expect(formatted).toContain("handoffs=payment_review,office_payout");
    expect(formatted).toContain("order=payout");
  });

  it("reports scenarios whose source fixture is missing and renders failures", () => {
    // Пустой список фикстур: каждый сценарий с sourceFixtureId «теряет» источник.
    const report = runExchangeSelfPlayScenarioCorpus({ fixtureCases: [] });
    expect(report.ok).toBe(false);
    const fixtureFailures = report.failures.filter(
      (failure) => failure.actual === "fixture id not found in exchange-workflows.jsonl",
    );
    expect(fixtureFailures.length).toBeGreaterThan(0);
    expect(fixtureFailures[0]?.expected).toStartWith("fixture ");

    const formatted = formatExchangeSelfPlayScenarioReport(report);
    expect(formatted).toContain("exchange self-play corpus: failed");
    expect(formatted).toContain("failures:");
    expect(formatted).toContain("actual=fixture id not found");
  });

  it("flags duplicate ids and structurally empty scenarios (corpus self-checks)", () => {
    // Эти ветки недостижимы на здоровом корпусе — временно «портим» корпус
    // (только на время теста, с восстановлением в finally).
    const corpus = EXCHANGE_SELF_PLAY_SCENARIOS as ExchangeSelfPlayScenario[];
    const broken: ExchangeSelfPlayScenario = {
      id: "coverage-broken-scenario",
      title: "Broken scenario for corpus self-checks",
      tags: ["exception"],
      clientScript: [],
      expectedWorkflow: [],
      expectedFields: [{ key: "asset", required: false, source: "client" }],
      expectedStages: [],
      expectedHandoffs: [],
      criticalReplyAssertions: [],
      debugHint: "coverage only",
    };
    const duplicate = { ...corpus[0]! };
    corpus.push(broken, duplicate);
    try {
      const report = runExchangeSelfPlayScenarioCorpus({
        scenarioId: "coverage-broken-scenario",
      });
      expect(report.ok).toBe(false);
      const expectations = report.failures.map((failure) => failure.expected);
      expect(expectations).toContain("unique scenario id");
      expect(expectations).toContain("at least one deterministic client turn");
      expect(expectations).toContain("required field expectations");
      expect(expectations).toContain("expected workflow stages");
      expect(expectations).toContain("critical reply assertions");
      expect(
        report.failures.find((failure) => failure.expected === "unique scenario id")?.scenarioId,
      ).toBe(duplicate.id);
    } finally {
      corpus.splice(corpus.indexOf(broken), 1);
      corpus.splice(corpus.indexOf(duplicate), 1);
    }
    // Корпус восстановлен — повторный прогон снова зелёный.
    expect(runExchangeSelfPlayScenarioCorpus({ fixtureCases: loadCases() }).ok).toBe(true);
  });
});
