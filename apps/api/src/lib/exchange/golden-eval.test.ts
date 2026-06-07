import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	evaluateExchangeGoldenCases,
	formatExchangeGoldenFailures,
	parseExchangeGoldenJsonl,
} from "./golden-eval.ts";

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

describe("exchange golden eval smoke", () => {
	it("loads 10 anonymized workflow cases", () => {
		const cases = loadCases();
		expect(cases).toHaveLength(10);
		for (const item of cases) {
			expect(item.id).toBeString();
			expect(item.expectedWorkflow.length).toBeGreaterThan(0);
			expect(JSON.stringify(item)).not.toContain("https://qr.nspk.ru");
			expect(JSON.stringify(item)).not.toContain("2202 ");
			expect(JSON.stringify(item)).not.toContain("Код: 289");
		}
	});

	it("covers quote, requisites, KYC and proof checkpoints", () => {
		const tokens = new Set(loadCases().flatMap((item) => item.expectedWorkflow));
		expect(tokens.has("rate_quote")).toBe(true);
		expect(tokens.has("kyc_required")).toBe(true);
		expect(
			["requisites_qr", "requisites_card", "requisites_crypto_wallet", "requisites_binance_id"].some(
				(token) => tokens.has(token),
			),
		).toBe(true);
		expect(tokens.has("receipt_request")).toBe(true);
	});

	it("passes deterministic guard and stage-policy smoke checks", () => {
		const results = evaluateExchangeGoldenCases(loadCases());
		const failures = formatExchangeGoldenFailures(results);
		expect(failures).toBe("");
		expect(results.every((result) => result.passed)).toBe(true);
	});

	it("formats case id, expected behavior, actual result and trace for failures", () => {
		const failures = formatExchangeGoldenFailures([
			{
				caseId: "case-1",
				passed: false,
				trace: ["rate_quote: exchange_request -> compute_exchange_quote"],
				failures: [
					{
						caseId: "case-1",
						expected: "quote through tool",
						actual: "draft was allowed",
						trace: ["rate_quote: exchange_request -> compute_exchange_quote"],
					},
				],
			},
		]);
		expect(failures).toContain("case=case-1");
		expect(failures).toContain("expected=quote through tool");
		expect(failures).toContain("actual=draft was allowed");
		expect(failures).toContain("trace=rate_quote");
	});
});
