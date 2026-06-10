import type { FunnelStage } from "@chatman-media/kb";
import { conversations as conversationsTable } from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./dal/types.ts";

/**
 * Pipeline contract: что pipeline ожидает от любого stage-classifier
 * (regex/LLM/external). Implementations живут в `@chatman-media/sales`
 * как sales-domain logic — sales имеет access к ChatClient и регекспам
 * для русских sales-cues.
 *
 * Здесь только TYPE — чтобы processInbound и apps/api могли референсить
 * без создания circular dep (sales → conv-engine для Db типов).
 *
 * НЕ путать с vertical-template'овским lead.state (intake_pending → docs →
 * visa) — это разные оси:
 *   - lead.state: операционный pipeline найма (один на лида)
 *   - conversation.current_stage: micro-state диалога продажи (per turn)
 */
export interface StageClassifier {
	/**
	 * Классифицирует stage по тексту user-message + опц. контексту.
	 * Возвращает FunnelStage или null если уверенности нет.
	 */
	classify(input: {
		/**
		 * Tenant контекст — нужен LLM-based реализациям для resolveChat
		 * (per-tenant LLM-config). Regex-impl игнорирует, но в interface
		 * required чтобы pipeline call-site всегда передавал реальный
		 * tenantId из processInbound deps.
		 */
		tenantId: number;
		userMessageText: string;
		previousStage: string | null;
		isFirstUserMessage: boolean;
	}): Promise<FunnelStage | null> | FunnelStage | null;
}

// ---- Pipeline-side helper ----------------------------------------------

/**
 * Обновляет `conversations.current_stage` если new стадия отличается от
 * существующей. Idempotent: same-stage → no UPDATE. Pipeline-side persistence
 * step — живёт в conv-engine (где DAL), а не в sales (где stage classifier
 * impls). Чтобы избежать circular dep, sales-impl'ы возвращают FunnelStage,
 * conv-engine берёт результат и применяет через applyClassifiedStage.
 */
export async function applyClassifiedStage(opts: {
	db: Db;
	tenantId: number;
	conversationId: number;
	newStage: FunnelStage | null;
}): Promise<boolean> {
	if (!opts.newStage) return false;
	const [row] = await opts.db
		.select({ stage: conversationsTable.currentStage })
		.from(conversationsTable)
		.where(
			and(
				eq(conversationsTable.id, opts.conversationId),
				eq(conversationsTable.tenantId, opts.tenantId),
			),
		);
	if (!row || row.stage === opts.newStage) return false;
	await opts.db
		.update(conversationsTable)
		.set({ currentStage: opts.newStage })
		.where(
			and(
				eq(conversationsTable.id, opts.conversationId),
				eq(conversationsTable.tenantId, opts.tenantId),
			),
		);
	return true;
}

// Silence unused sql import warning когда consumer не использует raw SQL.
void sql;
