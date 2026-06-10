import { describe, expect, it } from "bun:test";
import type { ChatClient } from "@chatman-media/llm-router";
import {
	type FunnelEvalScenario,
	formatFunnelEvalSummary,
	parseFunnelBuilderOutput,
	runLiveFunnelEval,
	scoreFunnelOutput,
} from "./funnel-builder-live-eval.ts";

const linearScenario: FunnelEvalScenario = {
	id: "linear-test",
	name: "Linear test",
	description: "school",
	expect: {
		requiredPhases: ["qualify", "offer"],
		fieldKeywords: ["имя", "цель"],
	},
};

const validLinear = JSON.stringify({
	reply: "Готово",
	readyToGenerate: true,
	stages: [
		{
			slug: "intake",
			displayName: "Заявка",
			kind: "intake",
			stageType: "form_fill",
			nextStages: ["qualify"],
			fields: [
				{
					slug: "name",
					displayName: "Имя",
					fieldType: "text",
					required: true,
					aiExtractable: true,
				},
			],
		},
		{
			slug: "qualify",
			displayName: "Квалификация",
			kind: "active",
			stageType: "form_fill",
			phase: "qualify",
			goal: "Понять цель обучения",
			guidance: "Спроси про цель и уровень.",
			nextStages: ["offer"],
			fields: [
				{
					slug: "goal",
					displayName: "Цель",
					fieldType: "text",
					required: true,
					aiExtractable: true,
				},
			],
		},
		{
			slug: "offer",
			displayName: "Оффер",
			kind: "active",
			stageType: "interaction",
			phase: "offer",
			goal: "Записать на пробный урок",
			guidance: "Предложи слот и подтверди запись.",
			nextStages: ["won", "lost"],
			fields: [],
		},
		{
			slug: "won",
			displayName: "Оплатил",
			kind: "terminal_won",
			stageType: "milestone",
			nextStages: [],
			fields: [],
		},
		{
			slug: "lost",
			displayName: "Отказ",
			kind: "terminal_lost",
			stageType: "milestone",
			nextStages: [],
			fields: [],
		},
	],
});

describe("funnel-builder live eval scoring", () => {
	it("passes a structurally valid linear funnel", () => {
		const result = scoreFunnelOutput(linearScenario, validLinear);
		expect(result.passed).toBe(true);
		expect(result.metrics.structuralValid).toBe(true);
		expect(result.metrics.phaseCoverage).toBe(1);
		expect(result.metrics.behaviorCoverage).toBe(1);
	});

	it("fails invalid JSON with concrete parse error", () => {
		const result = scoreFunnelOutput(linearScenario, "not json");
		expect(result.passed).toBe(false);
		expect(result.errors.some((error) => error.startsWith("Parse:"))).toBe(
			true,
		);
	});

	it("checks multi-request branch contract", () => {
		const scenario: FunnelEvalScenario = {
			id: "multi-test",
			name: "Multi test",
			description: "concierge",
			expect: {
				multiRequest: true,
				requestTypes: ["transfer", "food"],
				requiredPhases: ["qualify", "offer"],
				fieldKeywords: ["request_type"],
			},
		};
		const result = scoreFunnelOutput(
			scenario,
			JSON.stringify({
				reply: "Готово",
				stages: [
					{
						slug: "request_received",
						displayName: "Запрос",
						kind: "intake",
						stageType: "form_fill",
						nextStages: ["transfer_request", "food_request", "cancelled"],
						fields: [
							{
								slug: "request_type",
								displayName: "Тип запроса",
								fieldType: "select",
								required: true,
								aiExtractable: true,
								options: [
									{ value: "transfer", label: "Трансфер" },
									{ value: "food", label: "Еда" },
								],
							},
						],
					},
					stage("transfer_request", "Трансфер: детали", "qualify", [
						"transfer_offer",
					]),
					stage("food_request", "Еда: детали", "qualify", ["food_offer"]),
					stage("transfer_offer", "Трансфер: оффер", "offer", [
						"completed",
						"cancelled",
					]),
					stage("food_offer", "Еда: оффер", "offer", [
						"completed",
						"cancelled",
					]),
					terminal("completed", "Выполнено", "terminal_won"),
					terminal("cancelled", "Отменено", "terminal_lost"),
				],
			}),
		);
		expect(result.passed).toBe(true);
		expect(result.metrics.branchValid).toBe(true);
	});

	it("JSON без stages → parseError 'stages array missing', reply сохраняется", () => {
		const parsed = parseFunnelBuilderOutput(
			'{"reply":"расскажи подробнее про бизнес"}',
		);
		expect(parsed.parseError).toBe("stages array missing");
		expect(parsed.reply).toBe("расскажи подробнее про бизнес");
		expect(parsed.stages).toEqual([]);

		const result = scoreFunnelOutput(
			linearScenario,
			'{"reply":"мало данных"}',
		);
		expect(result.passed).toBe(false);
		expect(result.errors).toContain("Parse: stages array missing");
	});

	it("битый JSON внутри фигурных скобок → parseError из JSON.parse", () => {
		const parsed = parseFunnelBuilderOutput("Вот воронка: {oops, not: json}");
		expect(parsed.stages).toEqual([]);
		expect(parsed.reply).toBe("");
		expect(parsed.parseError).toBeTruthy();
		expect(parsed.parseError).not.toBe("no JSON object found");
		expect(parsed.parseError).not.toBe("stages array missing");
	});

	it("live runner retries repair prompts", async () => {
		let calls = 0;
		const chat: ChatClient = {
			complete: async () => {
				calls += 1;
				return calls === 1 ? '{"stages": [' : validLinear;
			},
		};
		const report = await runLiveFunnelEval({
			chat,
			scenarios: [linearScenario],
			maxRetries: 1,
			now: new Date("2026-06-09T00:00:00Z"),
		});
		expect(report.passed).toBe(1);
		expect(report.results[0]?.retryCount).toBe(1);
		expect(formatFunnelEvalSummary(report)).toContain("1/1 passed");
	});
});

function stage(
	slug: string,
	displayName: string,
	phase: "qualify" | "offer",
	nextStages: string[],
) {
	return {
		slug,
		displayName,
		kind: "active",
		stageType: "form_fill",
		phase,
		goal: `Goal ${displayName}`,
		guidance: `Guidance ${displayName}`,
		nextStages,
		fields: [],
	};
}

function terminal(
	slug: string,
	displayName: string,
	kind: "terminal_won" | "terminal_lost",
) {
	return {
		slug,
		displayName,
		kind,
		stageType: "milestone",
		nextStages: [],
		fields: [],
	};
}
