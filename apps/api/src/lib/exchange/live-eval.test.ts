import { describe, expect, it } from "bun:test";
import {
	buildDeterministicExchangeReplay,
	createDeterministicExchangeLiveEvalRunner,
	evaluateExchangeLiveReplay,
	formatExchangeLiveEvalSummary,
	runExchangeLiveEval,
} from "./live-eval.ts";
import { EXCHANGE_SELF_PLAY_SCENARIOS } from "./scenario-corpus.ts";

const scenario = EXCHANGE_SELF_PLAY_SCENARIOS.find(
	(item) => item.id === "rub-office-pickup-payment-proof",
);
if (!scenario) throw new Error("scenario fixture missing");

describe("exchange live eval", () => {
	it("passes the deterministic smoke corpus", async () => {
		const report = await runExchangeLiveEval({
			runner: createDeterministicExchangeLiveEvalRunner(),
			now: new Date("2026-06-10T00:00:00Z"),
		});

		expect(report.generatedAt).toBe("2026-06-10T00:00:00.000Z");
		expect(report.total).toBe(EXCHANGE_SELF_PLAY_SCENARIOS.length);
		expect(report.passed).toBe(report.total);
		expect(report.score).toBe(1);
		expect(formatExchangeLiveEvalSummary(report)).toContain(
			`${report.total}/${report.total} passed`,
		);
	});

	it("can run a single scenario", async () => {
		const report = await runExchangeLiveEval({
			runner: createDeterministicExchangeLiveEvalRunner(),
			scenarioId: "rub-office-pickup-payment-proof",
		});

		expect(report.total).toBe(1);
		expect(report.results[0]?.scenarioId).toBe(
			"rub-office-pickup-payment-proof",
		);
		expect(report.results[0]?.metrics.handoffCorrect).toBe(true);
	});

	it("reports missing required concrete fields", () => {
		const replay = buildDeterministicExchangeReplay(scenario);
		const result = evaluateExchangeLiveReplay(scenario, {
			...replay,
			actual: {
				...replay.actual,
				fields: { ...replay.actual.fields, payment_proof: undefined },
			},
		});

		expect(result.passed).toBe(false);
		expect(
			result.failures.some((failure) => failure.kind === "field_missing"),
		).toBe(true);
		expect(result.metrics.fieldAccuracy).toBeLessThan(1);
	});

	it("reports missing stages and handoffs", () => {
		const replay = buildDeterministicExchangeReplay(scenario);
		const result = evaluateExchangeLiveReplay(scenario, {
			...replay,
			actual: {
				...replay.actual,
				stages: ["exchange_request"],
				handoffs: ["payment_review"],
			},
		});

		expect(result.passed).toBe(false);
		expect(
			result.failures.some((failure) => failure.kind === "stage_missing"),
		).toBe(true);
		expect(
			result.failures.some((failure) => failure.kind === "handoff_missing"),
		).toBe(true);
	});

	it("reports guard findings and forbidden reply text", () => {
		const replay = buildDeterministicExchangeReplay(scenario);
		const result = evaluateExchangeLiveReplay(scenario, {
			...replay,
			transcript: [
				...replay.transcript,
				{
					role: "assistant",
					text: "Оплата подтверждена, можете забирать.",
				},
			],
			actual: {
				...replay.actual,
				guardFindings: [
					{
						action: "escalate",
						reasons: ["payment_auto_verified"],
						requiredFixes: ["payment review"],
						originalText: "Оплата подтверждена.",
						finalText: "Проверку оплаты должен выполнить оператор.",
						blocked: false,
					},
				],
			},
		});

		expect(result.passed).toBe(false);
		expect(result.metrics.guardViolationCount).toBe(1);
		expect(
			result.failures.some((failure) => failure.kind === "guard_violation"),
		).toBe(true);
		expect(
			result.failures.some((failure) => failure.kind === "reply_assertion"),
		).toBe(true);
	});
});
