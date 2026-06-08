import { describe, expect, it } from "bun:test";
import { type ActivePhase, validateBackbone } from "@chatman-media/verticals";
import {
	normalizeSeedStageConfigJson,
	resolveSeedPhase,
	SEED_TEMPLATES,
	stageWorkflowTransitions,
	type SeedStage,
} from "./admin-funnel.ts";

// Применяет ту же логику фаз, что applyFunnelStages (resolveSeedPhase), и
// проверяет, что каждый seed-шаблон удовлетворяет костяку без ошибок.
function withPhases(stages: SeedStage[]) {
	let prev: ActivePhase | null = null;
	return stages.map((s) => {
		const phase = resolveSeedPhase(s, prev);
		if (phase) prev = phase;
		return { ...s, phase: phase ?? undefined };
	});
}

describe("SEED_TEMPLATES соответствуют костяку", () => {
	for (const [key, stages] of Object.entries(SEED_TEMPLATES)) {
		it(`${key}: validateBackbone без ошибок`, () => {
			const v = validateBackbone(withPhases(stages));
			expect(v.errors).toEqual([]);
		});
	}
});

describe("5 вертикалей: явные теги фаз сохранены", () => {
	const expected: Record<string, Record<string, ActivePhase>> = {
		exchange: {
			quote_calculated: "offer",
			kyc_collection: "clear",
			payment_verified: "fulfill",
		},
		video: {
			brief_call: "qualify",
			quote_approved: "offer",
			delivery: "fulfill",
		},
		recruitment: {
			intake_complete: "qualify",
			partner_review: "offer",
			visa_filing: "clear",
			ready_to_work: "fulfill",
		},
		real_estate: {
			viewings: "qualify",
			mou_signed: "offer",
			noc_application: "clear",
			handover_support: "fulfill",
		},
		saas: {
			qualified: "qualify",
			demo_done: "qualify",
			proposal_sent: "offer",
		},
	};
	for (const [key, slugPhases] of Object.entries(expected)) {
		it(`${key}: ключевые стадии в ожидаемых фазах`, () => {
			const bySlug = new Map(SEED_TEMPLATES[key]!.map((s) => [s.slug, s]));
			for (const [slug, phase] of Object.entries(slugPhases)) {
				expect(bySlug.get(slug)?.phase).toBe(phase);
			}
		});
	}
});

describe("SEED_TEMPLATES workflow runtime config", () => {
	it("строит explicit transition для линейного legacy auto-advance stage", () => {
		const configJson = normalizeSeedStageConfigJson({
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			nextStages: ["offer", "lost"],
			fields: [{ slug: "budget" }],
		});
		const config = JSON.parse(configJson) as {
			workflow?: {
				transitions?: Array<{ to?: string; when?: { type?: string } }>;
			};
		};
		expect(config.workflow?.transitions?.[0]).toMatchObject({
			to: "offer",
			when: { type: "all_required_fields_filled" },
		});
	});

	it("не фиксирует to для request_type branching stage", () => {
		const configJson = normalizeSeedStageConfigJson({
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			nextStages: ["exchange_request", "transfer_request", "cancelled"],
			fields: [{ slug: "request_type" }],
		});
		const config = JSON.parse(configJson) as {
			workflow?: {
				transitions?: Array<{ to?: string; when?: { type?: string } }>;
			};
		};
		expect(config.workflow?.transitions?.[0]?.when?.type).toBe(
			"all_required_fields_filled",
		);
		expect(config.workflow?.transitions?.[0]?.to).toBeUndefined();
	});

	it("сохраняет явно заданные workflow transitions", () => {
		const configJson = normalizeSeedStageConfigJson({
			configJson: JSON.stringify({
				workflow: {
					transitions: [
						{
							to: "manual_next",
							when: { type: "all_required_fields_filled" },
							priority: 50,
						},
					],
				},
				other: { keep: true },
			}),
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			nextStages: ["first_next"],
			fields: [{ slug: "field" }],
		});
		const config = JSON.parse(configJson) as {
			workflow?: { transitions?: Array<{ to?: string; priority?: number }> };
			other?: { keep?: boolean };
		};
		expect(config.workflow?.transitions?.[0]).toMatchObject({
			to: "manual_next",
			priority: 50,
		});
		expect(config.other?.keep).toBe(true);
	});

	it("каждая legacy auto-advance стадия seed templates получает workflow transition", () => {
		for (const [template, stages] of Object.entries(SEED_TEMPLATES)) {
			for (const stage of stages) {
				if (
					stage.autoAdvanceCondition !==
						'{"type":"all_required_fields_filled"}' ||
					stage.nextStages.length === 0
				) {
					continue;
				}
				const configJson = normalizeSeedStageConfigJson({
					configJson: stage.configJson,
					autoAdvanceCondition: stage.autoAdvanceCondition,
					nextStages: stage.nextStages,
					fields: stage.fields,
				});
				expect(
					stageWorkflowTransitions(configJson).length,
					`${template}/${stage.slug} should persist workflow.transitions`,
				).toBeGreaterThan(0);
			}
		}
	});
});
