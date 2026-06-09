import { describe, expect, it } from "bun:test";
import { defaultRegistry } from "@chatman-media/verticals";
// Side-effect import регистрирует template в defaultRegistry.
import "./index.ts";

describe("exchange_v1 template", () => {
	it("регистрируется в defaultRegistry при import", () => {
		const t = defaultRegistry.load("exchange_v1");
		expect(t.displayName).toBe("Обмен валют — v1");
		expect(t.version).toBe(2);
	});

	it("funnel-stages образуют валидную state machine", () => {
		const t = defaultRegistry.load("exchange_v1");
		const slugs = new Set(t.funnelStages.map((s) => s.slug));
		for (const stage of t.funnelStages) {
			for (const next of stage.next ?? []) {
				expect(slugs.has(next)).toBe(true);
			}
		}
		for (const stage of t.funnelStages) {
			if (stage.kind === "terminal") {
				expect(stage.next).toBeUndefined();
			}
		}
	});

	it("intake stage существует в funnel и совпадает со ссылкой в questionnaire", () => {
		const t = defaultRegistry.load("exchange_v1");
		const intakeStage = t.funnelStages.find((s) => s.kind === "intake");
		expect(intakeStage).toBeDefined();
		expect(t.questionnaire?.stageSlug).toBe(intakeStage?.slug);
	});

	it("все required intake поля имеют непустое question", () => {
		const t = defaultRegistry.load("exchange_v1");
		for (const field of t.questionnaire?.fields ?? []) {
			if (field.required) {
				expect(field.question.length).toBeGreaterThan(0);
			}
		}
	});

	it("enum-поля имеют непустые options", () => {
		const t = defaultRegistry.load("exchange_v1");
		for (const field of t.questionnaire?.fields ?? []) {
			if (field.kind === "enum") {
				expect(field.options).toBeDefined();
				expect(field.options?.length).toBeGreaterThan(0);
			}
		}
	});
});
