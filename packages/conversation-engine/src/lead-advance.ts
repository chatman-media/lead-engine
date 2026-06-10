import {
	funnels,
	leads as leadsTable,
	stageDefinitions,
} from "@chatman-media/storage";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./dal/types.ts";

/**
 * Маппинг sales-микростадии диалога (opener|qualify|pitch|objection|close)
 * на универсальную фазу воронки (capture|qualify|offer|clear|fulfill).
 * Источник фаз — stage_definitions.phase активной воронки тенанта.
 *
 * opener   → ещё нет интента (лид НЕ заводим)
 * qualify  → capture/qualify: цель определена, собираем параметры
 * pitch    → offer: показываем условия (курс/цену)
 * objection→ clear: верификация/KYC/возражения
 * close    → fulfill: оформление/оплата/выдача
 */
const SALES_STAGE_TO_PHASE: Record<string, string> = {
	qualify: "qualify",
	pitch: "offer",
	objection: "clear",
	close: "fulfill",
};

/**
 * Find-or-create лид для (tenant, contact) на активной воронке тенанта и
 * продвигает его вперёд до фазы, соответствующей текущей sales-стадии диалога.
 * Двигает ТОЛЬКО вперёд (по position); назад не откатывает.
 *
 * Обновляет lead.state + lead.stageDefinitionId синхронно (как admin-leads /
 * field-extractor). Работает поверх DB-воронки (stage_definitions), а не
 * template.funnelStages — это «живая» позиция в кастомной воронке тенанта.
 *
 * Возвращает null если у тенанта нет активной воронки со стадиями.
 */
export async function ensureAndAdvanceLeadByPhase(opts: {
	db: Db;
	tenantId: number;
	contactId: number;
	/** sales-стадия из stage-classifier (opener|qualify|pitch|objection|close). */
	salesStage: string;
	nowEpoch: number;
}): Promise<{
	leadId: number;
	stageSlug: string;
	created: boolean;
	advanced: boolean;
} | null> {
	const { db, tenantId, contactId, salesStage, nowEpoch } = opts;

	const stages = await db
		.select({
			id: stageDefinitions.id,
			slug: stageDefinitions.slug,
			phase: stageDefinitions.phase,
			kind: stageDefinitions.kind,
			position: stageDefinitions.position,
		})
		.from(stageDefinitions)
		.innerJoin(funnels, eq(stageDefinitions.funnelId, funnels.id))
		.where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
		.orderBy(asc(stageDefinitions.position));
	if (stages.length === 0) return null;

	const initial = stages.find((s) => s.kind === "intake") ?? stages[0]!;

	// find-or-create lead
	const [existing] = await db
		.select({
			id: leadsTable.id,
			state: leadsTable.state,
			stageDefinitionId: leadsTable.stageDefinitionId,
		})
		.from(leadsTable)
		.where(
			and(eq(leadsTable.tenantId, tenantId), eq(leadsTable.userId, contactId)),
		)
		.limit(1);

	let leadId: number;
	let curStageId: number | null;
	let curSlug: string;
	let created = false;
	if (existing) {
		leadId = existing.id;
		curStageId = existing.stageDefinitionId ?? null;
		curSlug = existing.state;
	} else {
		const [row] = await db
			.insert(leadsTable)
			.values({
				tenantId,
				userId: contactId,
				state: initial.slug,
				stageDefinitionId: initial.id,
				createdAt: nowEpoch,
				updatedAt: nowEpoch,
			})
			.returning({ id: leadsTable.id });
		if (!row) return null;
		leadId = row.id;
		curStageId = initial.id;
		curSlug = initial.slug;
		created = true;
	}

	const targetPhase = SALES_STAGE_TO_PHASE[salesStage];
	if (!targetPhase)
		return { leadId, stageSlug: curSlug, created, advanced: false };

	const curStage =
		curStageId != null ? stages.find((s) => s.id === curStageId) : undefined;
	const curPos = curStage?.position ?? -1;

	// Эскалация до WON: если клиент закрывается (close) и лид уже в фазе
	// fulfill (оформление/оплата) — доводим до терминальной выигранной стадии.
	// Так устойчивый close в конце диалога даёт «лид, прошедший всю воронку».
	let target =
		salesStage === "close" && curStage?.phase === "fulfill"
			? stages.find((s) => s.kind === "terminal_won")
			: undefined;

	// Иначе — первая нетерминальная стадия целевой фазы.
	if (!target) {
		target = stages.find(
			(s) =>
				s.phase === targetPhase &&
				s.kind !== "terminal_won" &&
				s.kind !== "terminal_lost",
		);
	}
	if (!target) return { leadId, stageSlug: curSlug, created, advanced: false };
	if (target.position > curPos) {
		await db
			.update(leadsTable)
			.set({
				stageDefinitionId: target.id,
				state: target.slug,
				updatedAt: nowEpoch,
			})
			.where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
		return { leadId, stageSlug: target.slug, created, advanced: true };
	}

	return { leadId, stageSlug: curSlug, created, advanced: false };
}
