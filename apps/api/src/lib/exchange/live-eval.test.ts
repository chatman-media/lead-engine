import { describe, expect, it } from "bun:test";
import {
	buildDeterministicExchangeReplay,
	createDeterministicExchangeLiveEvalRunner,
	evaluateExchangeLiveReplay,
	formatExchangeLiveEvalSummary,
	runExchangeLiveEval,
} from "./live-eval.ts";
import {
	EXCHANGE_SELF_PLAY_SCENARIOS,
	type ExchangeSelfPlayScenario,
} from "./scenario-corpus.ts";

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

// ── Ветки скоринга, недостижимые на «здоровом» корпусе: синтетический сценарий ──

function syntheticScenario(
	overrides: Partial<ExchangeSelfPlayScenario>,
): ExchangeSelfPlayScenario {
	return {
		id: "synthetic-coverage-scenario",
		title: "Synthetic coverage scenario",
		tags: ["usdt"],
		clientScript: ["хочу обмен"],
		expectedWorkflow: ["rate_quote"],
		expectedFields: [
			{ key: "asset", required: true, value: "USDT", source: "client" },
		],
		expectedStages: ["exchange_request"],
		expectedHandoffs: [],
		criticalReplyAssertions: [
			{
				id: "synthetic-assertion",
				description: "must mention the rate tool",
				mustIncludeAny: ["курс"],
			},
		],
		debugHint: "synthetic",
		...overrides,
	};
}

describe("exchange live eval — failure branches", () => {
	it("reports field mismatch when value differs from expectation", () => {
		const scenario = syntheticScenario({});
		const result = evaluateExchangeLiveReplay(scenario, {
			scenarioId: scenario.id,
			mode: "deterministic_mock",
			transcript: [{ role: "assistant", text: "курс посчитан" }],
			actual: {
				fields: { asset: "BTC" },
				stages: scenario.expectedStages,
				order: null,
				handoffs: [],
			},
		});
		expect(result.passed).toBe(false);
		expect(
			result.failures.some((failure) => failure.kind === "field_mismatch"),
		).toBe(true);
		expect(result.metrics.fieldAccuracy).toBe(0);
	});

	it("reports unexpected order when scenario expects none", () => {
		const scenario = syntheticScenario({});
		const result = evaluateExchangeLiveReplay(scenario, {
			scenarioId: scenario.id,
			mode: "deterministic_mock",
			transcript: [{ role: "assistant", text: "курс посчитан" }],
			actual: {
				fields: { asset: "USDT" },
				stages: scenario.expectedStages,
				order: { status: "awaiting_payment" },
				handoffs: [],
			},
		});
		expect(result.passed).toBe(false);
		expect(
			result.failures.some((failure) => failure.kind === "order_unexpected"),
		).toBe(true);
		expect(result.metrics.orderCorrect).toBe(false);
	});

	it("reports order field mismatches against expected order", () => {
		const scenario = syntheticScenario({
			expectedOrder: {
				status: "paid",
				paymentMethod: "sbp_qr",
				payoutMethod: "office_cash",
			},
		});
		const result = evaluateExchangeLiveReplay(scenario, {
			scenarioId: scenario.id,
			mode: "live",
			transcript: [{ role: "assistant", text: "курс посчитан" }],
			actual: {
				fields: { asset: "USDT" },
				stages: scenario.expectedStages,
				order: { status: "awaiting_payment", paymentMethod: "sbp_qr" },
				handoffs: [],
			},
		});
		expect(result.passed).toBe(false);
		const mismatches = result.failures.filter(
			(failure) => failure.kind === "order_mismatch",
		);
		expect(mismatches.length).toBe(2); // status + payoutMethod
		expect(mismatches.map((failure) => failure.message)).toContain(
			"Order mismatch: status",
		);
	});

	it("reports missing mustIncludeAny tokens and replay errors", () => {
		const scenario = syntheticScenario({});
		const result = evaluateExchangeLiveReplay(scenario, {
			scenarioId: scenario.id,
			mode: "live",
			transcript: [{ role: "assistant", text: "без ключевого слова" }],
			actual: {
				fields: { asset: "USDT" },
				stages: scenario.expectedStages,
				order: null,
				handoffs: [],
			},
			error: "runner exploded",
		});
		expect(result.passed).toBe(false);
		expect(
			result.failures.some(
				(failure) =>
					failure.kind === "reply_assertion" &&
					failure.message.includes("missing include token"),
			),
		).toBe(true);
		expect(
			result.failures.some((failure) => failure.kind === "replay_error"),
		).toBe(true);
		expect(result.metrics.replyAssertionsPassed).toBe(false);
	});

	it("deterministic replay falls back to a generic assistant reply for unknown ids", () => {
		const replay = buildDeterministicExchangeReplay(
			syntheticScenario({ id: "unknown-coverage-id" }),
		);
		const assistant = replay.transcript.at(-1);
		expect(assistant?.role).toBe("assistant");
		expect(assistant?.text).toContain("Принял данные");
	});

	it("summary includes seed snapshot line when present", async () => {
		const report = await runExchangeLiveEval({
			runner: createDeterministicExchangeLiveEvalRunner(),
			scenarioId: "rub-office-pickup-payment-proof",
			seed: {
				tenantId: 7,
				tenantSlug: "demo-exchange",
				activeChannels: 2,
				activeRates: 3,
				exchangeResponseGuardEnabled: true,
			},
		});
		expect(report.seed?.tenantSlug).toBe("demo-exchange");
		const summary = formatExchangeLiveEvalSummary(report);
		expect(summary).toContain("seed tenant=demo-exchange channels=2 rates=3 guard=on");
	});
});
