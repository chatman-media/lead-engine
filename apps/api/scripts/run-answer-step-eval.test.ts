// Юнит-тесты чистых хелперов answer-step-eval CLI (#515): парсинг аргументов,
// агрегация повторов, медиана, markdown-рендер. Без сети и БД.

import { describe, expect, it } from "bun:test";
import type { RagGoldenReport } from "@chatman-media/kb";
import {
	aggregate,
	buildAblations,
	type CellStat,
	median,
	parseCliArgs,
	renderMarkdown,
} from "./run-answer-step-eval.ts";

describe("parseCliArgs", () => {
	it("дефолты: tenant 3, repeats 2, стандартный датасет", () => {
		const args = parseCliArgs([]);
		expect("error" in args).toBe(false);
		if ("error" in args) return;
		expect(args.tenantId).toBe(3);
		expect(args.repeats).toBe(2);
		expect(args.dataset).toContain("answer-steps.jsonl");
	});

	it("разбирает все флаги", () => {
		const args = parseCliArgs([
			"--tenant",
			"7",
			"--repeats",
			"3",
			"--dataset",
			"x.jsonl",
			"--out-md",
			"out.md",
			"--out-json",
			"out.json",
		]);
		if ("error" in args) throw new Error(args.error);
		expect(args.tenantId).toBe(7);
		expect(args.repeats).toBe(3);
		expect(args.dataset).toBe("x.jsonl");
		expect(args.outMd).toBe("out.md");
		expect(args.outJson).toBe("out.json");
	});

	it("невалидные значения → error", () => {
		expect("error" in parseCliArgs(["--tenant", "abc"])).toBe(true);
		expect("error" in parseCliArgs(["--repeats", "0"])).toBe(true);
		expect("error" in parseCliArgs(["--wat"])).toBe(true);
	});
});

describe("buildAblations", () => {
	it("содержит все варианты матрицы #515", () => {
		const ids = buildAblations().map((ablation) => ablation.id);
		expect(ids).toEqual(["no_rewrite", "no_multi_query", "no_reflect", "prod_default", "minimal"]);
	});

	it("аблации мутируют только свои флаги", () => {
		const base = {
			rewriteQueryBeforeRetrieval: true,
			multiQuery: true,
			reflect: true,
		} as never;
		const byId = new Map(buildAblations().map((ablation) => [ablation.id, ablation]));
		const noRewrite = byId.get("no_rewrite")?.mutateInput(base, {} as never) as Record<
			string,
			unknown
		>;
		expect(noRewrite.rewriteQueryBeforeRetrieval).toBe(false);
		expect(noRewrite.multiQuery).toBe(true);
		const minimal = byId.get("minimal")?.mutateInput(base, {} as never) as Record<string, unknown>;
		expect(minimal.rewriteQueryBeforeRetrieval).toBe(false);
		expect(minimal.multiQuery).toBe(false);
		expect(minimal.reflect).toBe(false);
	});
});

describe("median", () => {
	it("нечётное/чётное/пустое", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(median([])).toBe(0);
	});
});

function fakeReport(passRate: number): RagGoldenReport {
	return {
		generatedAt: "2026-06-10T00:00:00.000Z",
		variants: [
			{
				variantId: "baseline",
				label: "Baseline",
				total: 4,
				passed: Math.round(passRate * 4),
				failed: 4 - Math.round(passRate * 4),
				passRate,
				meanRetrievalRecall: 0.9,
				meanGroundedness: 0.8,
				meanPersonaConsistency: 1,
				forbiddenViolations: 1,
				pathCounts: { ok: 3, ungrounded: 1 },
			},
		],
		results: [],
	};
}

describe("aggregate + renderMarkdown", () => {
	it("усредняет повторы и считает медиану латентности по ячейкам", () => {
		const cells: CellStat[] = [
			{ variantId: "baseline", caseId: "a", chatCalls: 3, chatMs: 100 },
			{ variantId: "baseline", caseId: "b", chatCalls: 1, chatMs: 300 },
		];
		const [agg] = aggregate([fakeReport(0.5), fakeReport(1)], cells);
		expect(agg).toBeDefined();
		if (!agg) return;
		expect(agg.runs).toBe(2);
		expect(agg.passRate).toBeCloseTo(0.75);
		expect(agg.meanChatCalls).toBe(2);
		expect(agg.medianCaseMs).toBe(200);
		expect(agg.pathCounts.ok).toBe(6);
		expect(agg.forbiddenViolations).toBe(2);

		const markdown = renderMarkdown([agg], {
			dataset: "x.jsonl",
			cases: 4,
			repeats: 2,
			chatLabel: "openrouter/gemini",
			embedLabel: "openai/te3s",
		});
		expect(markdown).toContain("| Baseline | 75.0% |");
		expect(markdown).toContain("ok=6");
		expect(markdown).toContain("openrouter/gemini");
	});
});
