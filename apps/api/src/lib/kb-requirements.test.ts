/**
 * Unit-тесты kb-requirements: построение KB-чеклиста по структуре воронки
 * (buildKbRequirementDrafts) и матчинг покрытия документами (coverKbRequirements).
 * Чистые функции — без БД.
 */

import { describe, expect, it } from "bun:test";
import {
	buildKbRequirementDrafts,
	coverKbRequirements,
	type KbRequirementCoverageDocument,
	type KbRequirementDraft,
} from "./kb-requirements.ts";

const baseFunnel = { id: 7, slug: "main_funnel", verticalTemplateId: null };

function stage(
	slug: string,
	stageType: string,
	fields: Array<{ fieldType: string; required: boolean }> = [],
) {
	return { slug, displayName: `Стадия ${slug}`, stageType, fields };
}

describe("buildKbRequirementDrafts", () => {
	it("обычная воронка без стадий → 3 базовых funnel-требования", () => {
		const drafts = buildKbRequirementDrafts({
			funnel: baseFunnel,
			stages: [],
		});
		expect(drafts.map((d) => d.key)).toEqual([
			"business_overview",
			"process_and_sla",
			"pricing_terms",
		]);
		expect(
			drafts.every(
				(d) =>
					d.scopeType === "funnel" &&
					d.funnelId === 7 &&
					d.stageSlug === null &&
					d.required,
			),
		).toBe(true);
	});

	it("exchange-воронка (по slug и по vertical_template_id) → +4 exchange-требования", () => {
		const bySlug = buildKbRequirementDrafts({
			funnel: { id: 1, slug: "exchange_thb", verticalTemplateId: null },
			stages: [],
		});
		const byTemplate = buildKbRequirementDrafts({
			funnel: { id: 2, slug: "main", verticalTemplateId: "exchange_v1" },
			stages: [],
		});
		for (const drafts of [bySlug, byTemplate]) {
			const keys = drafts.map((d) => d.key);
			expect(keys).toContain("exchange_how_to_pay");
			expect(keys).toContain("exchange_kyc_aml");
			expect(keys).toContain("exchange_payout");
			expect(keys).toContain("exchange_locations");
		}
		const payout = byTemplate.find((d) => d.key === "exchange_payout");
		expect(payout).toMatchObject({
			topic: "payout",
			required: true,
			scopeType: "funnel",
			funnelId: 2,
			stageSlug: null,
		});
	});

	it("стадии payment/document/media → соответствующие stage-требования", () => {
		const drafts = buildKbRequirementDrafts({
			funnel: baseFunnel,
			stages: [
				stage("pay", "payment"),
				stage("upload", "document_upload"),
				stage("sign", "document_signature"),
				stage("media", "form_fill", [{ fieldType: "photo", required: true }]),
				stage("optional_media", "form_fill", [
					{ fieldType: "photo", required: false },
					{ fieldType: "text", required: true },
				]),
			],
		});
		const keys = drafts.map((d) => d.key);
		expect(keys).toContain("stage_pay_payment");
		expect(keys).toContain("stage_upload_documents");
		expect(keys).toContain("stage_sign_documents");
		expect(keys).toContain("stage_media_documents");
		expect(keys).not.toContain("stage_optional_media_documents");
		expect(drafts.find((d) => d.key === "stage_pay_payment")).toMatchObject({
			topic: "payment",
			required: true,
			scopeType: "stage",
			stageSlug: "pay",
		});
	});

	it("awaiting_operator/external_approval → необязательное handoff-требование", () => {
		const drafts = buildKbRequirementDrafts({
			funnel: baseFunnel,
			stages: [
				stage("operator", "awaiting_operator"),
				stage("approval", "external_approval"),
			],
		});
		const handoff = drafts.find((d) => d.key === "stage_operator_handoff");
		expect(handoff).toMatchObject({
			topic: "operator_handoff",
			required: false,
			scopeType: "stage",
			funnelId: 7,
			stageSlug: "operator",
		});
		expect(handoff?.title).toContain("Стадия operator");
		expect(drafts.find((d) => d.key === "stage_approval_handoff")).toMatchObject({
			topic: "operator_handoff",
			stageSlug: "approval",
		});
	});

	it("rate_confirmation → обязательное rates-требование", () => {
		const drafts = buildKbRequirementDrafts({
			funnel: baseFunnel,
			stages: [stage("rate", "rate_confirmation")],
		});
		expect(drafts.find((d) => d.key === "stage_rate_rate_policy")).toMatchObject({
			topic: "rates",
			required: true,
			scopeType: "stage",
			stageSlug: "rate",
		});
	});

	it("дубликат ключа не перезаписывает первое требование", () => {
		const drafts = buildKbRequirementDrafts({
			funnel: baseFunnel,
			stages: [stage("pay", "payment"), stage("pay", "payment")],
		});
		expect(drafts.filter((d) => d.key === "stage_pay_payment")).toHaveLength(1);
	});
});

describe("coverKbRequirements", () => {
	const funnelReq: KbRequirementDraft = {
		key: "pricing_terms",
		title: "Цены",
		description: "d",
		topic: "pricing",
		required: true,
		scopeType: "funnel",
		funnelId: 7,
		stageSlug: null,
	};
	const stageReq: KbRequirementDraft = {
		key: "stage_pay_payment",
		title: "Оплата",
		description: "d",
		topic: "payment",
		required: true,
		scopeType: "stage",
		funnelId: 7,
		stageSlug: "pay",
	};

	function doc(
		overrides: Partial<KbRequirementCoverageDocument>,
	): KbRequirementCoverageDocument {
		return {
			topic: null,
			scopeType: "global",
			funnelId: null,
			stageSlug: null,
			...overrides,
		};
	}

	it("global-документ с совпадающим topic покрывает требование", () => {
		const [covered] = coverKbRequirements(
			[funnelReq],
			[doc({ topic: "pricing", scopeType: "global" })],
		);
		expect(covered).toMatchObject({ covered: true, matchedDocuments: 1 });
	});

	it("несовпадающий topic → не покрыт", () => {
		const [covered] = coverKbRequirements(
			[funnelReq],
			[doc({ topic: "other", scopeType: "global" })],
		);
		expect(covered).toMatchObject({ covered: false, matchedDocuments: 0 });
	});

	it("topic может матчиться и по key требования", () => {
		const [covered] = coverKbRequirements(
			[funnelReq],
			[doc({ topic: "pricing_terms", scopeType: "global" })],
		);
		expect(covered).toMatchObject({ covered: true, matchedDocuments: 1 });
	});

	it("funnel-документ матчится только по своему funnelId", () => {
		const [own] = coverKbRequirements(
			[funnelReq],
			[doc({ topic: "pricing", scopeType: "funnel", funnelId: 7 })],
		);
		expect(own?.covered).toBe(true);
		const [foreign] = coverKbRequirements(
			[funnelReq],
			[doc({ topic: "pricing", scopeType: "funnel", funnelId: 8 })],
		);
		expect(foreign?.covered).toBe(false);
	});

	it("stage-документ требует совпадения funnelId и stageSlug", () => {
		const [own] = coverKbRequirements(
			[stageReq],
			[
				doc({
					topic: "payment",
					scopeType: "stage",
					funnelId: 7,
					stageSlug: "pay",
				}),
			],
		);
		expect(own).toMatchObject({ covered: true, matchedDocuments: 1 });
		const [wrongStage] = coverKbRequirements(
			[stageReq],
			[
				doc({
					topic: "payment",
					scopeType: "stage",
					funnelId: 7,
					stageSlug: "other_stage",
				}),
			],
		);
		expect(wrongStage?.covered).toBe(false);
	});

	it("неизвестный scopeType документа не покрывает ничего", () => {
		const [covered] = coverKbRequirements(
			[funnelReq],
			[doc({ topic: "pricing", scopeType: "galaxy" })],
		);
		expect(covered?.covered).toBe(false);
	});

	it("считает все совпавшие документы", () => {
		const [covered] = coverKbRequirements(
			[stageReq],
			[
				doc({ topic: "payment", scopeType: "global" }),
				doc({ topic: "payment", scopeType: "funnel", funnelId: 7 }),
				doc({
					topic: "stage_pay_payment",
					scopeType: "stage",
					funnelId: 7,
					stageSlug: "pay",
				}),
				doc({ topic: "payment", scopeType: "funnel", funnelId: 99 }),
			],
		);
		expect(covered).toMatchObject({ covered: true, matchedDocuments: 3 });
	});
});
