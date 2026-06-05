import { describe, expect, it } from "bun:test";
import { allPlans, resolvePlan } from "./plans.ts";

describe("plans", () => {
	it("resolvePlan known kinds", () => {
		expect(resolvePlan("free").label).toBe("Free");
		expect(resolvePlan("starter").label).toBe("Starter");
		expect(resolvePlan("pro").label).toBe("Pro");
		expect(resolvePlan("enterprise").label).toBe("Enterprise");
	});

	it("resolvePlan unknown → free fallback + onUnknown called", () => {
		const seen: string[] = [];
		const p = resolvePlan("legacy_bogus", (s) => seen.push(s));
		expect(p.label).toBe("Free");
		expect(seen).toEqual(["legacy_bogus"]);
	});

	it("платные тарифы эскалируют maxChannels", () => {
		// Кастомная версия для обменки: FREE намеренно щедрый (без биллинга),
		// поэтому монотонность free<starter<pro не проверяем. Среди платных —
		// эскалация сохраняется.
		expect(resolvePlan("starter").maxChannels).toBeLessThan(
			resolvePlan("pro").maxChannels,
		);
		expect(resolvePlan("pro").maxChannels).toBeLessThanOrEqual(
			resolvePlan("enterprise").maxChannels,
		);
	});

	it("FREE щедрый: каналов и документов с запасом (биллинг отключён)", () => {
		expect(resolvePlan("free").maxChannels).toBeGreaterThanOrEqual(3);
		expect(resolvePlan("free").maxKbDocuments).toBeGreaterThanOrEqual(1000);
	});

	it("allPlans → returns 4 tiers", () => {
		const list = allPlans();
		expect(list).toHaveLength(4);
		expect(list.map((p) => p.kind).sort()).toEqual([
			"enterprise",
			"free",
			"pro",
			"starter",
		]);
	});

	it("free plan zero price, enterprise null price", () => {
		expect(resolvePlan("free").priceUsd).toBe(0);
		expect(resolvePlan("enterprise").priceUsd).toBeNull();
		// Phase 1 pricing pivot — was $49/$149, now $99/$199 для recruitment ARPU.
		expect(resolvePlan("starter").priceUsd).toBe(99);
		expect(resolvePlan("pro").priceUsd).toBe(199);
	});
});
