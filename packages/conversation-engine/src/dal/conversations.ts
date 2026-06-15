import {
	auditLog,
	conversations as conversationsTable,
} from "@chatman-media/storage";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface ConversationRow {
	id: number;
	tenantId: number;
	userId: number;
	channelId: number | null;
	source: string;
	mode: "ai" | "queued" | "human";
	status: "open" | "pending" | "resolved";
	unreadCount: number;
	lastMessageText: string | null;
	escalatedAt: number | null;
	assignedAdminId: number | null;
	lastMessageAt: number | null;
	createdAt: number;
	styleId: number | null;
	experimentId: number | null;
	currentStage: string | null;
	summaryJson: string | null;
	metaJson: string | null;
	replyDueAt: number | null;
	fallbackStreak: number;
	offhoursLastAutoSent: number | null;
	/** #651 — топик форум-группы оператора (Telegram message_thread_id). */
	operatorThreadId: number | null;
}

/**
 * Conversations repo. Поле `userId` — legacy: было задумано как ссылка
 * на старую таблицу users. Сейчас conversations.user_id хранит contact.id
 * (мы reused колонку чтобы избежать схема-миграции при backfill).
 * После Этапа 8 (миграция users → contacts) переименуем колонку в
 * contact_id.
 *
 * `source` is the legacy 'bot|userbot|self_play' enum for older inbox/query
 * paths. New channel-aware conversations use channelId and are unique per
 * (contact_id, channel_id); legacy rows without channelId stay unique per
 * (contact_id, source).
 */
export class ConversationsRepo {
	constructor(private readonly ctx: RepoCtx) {}

	/**
	 * Find the legacy conversation per (contactId, source). The partial
	 * uniq_conversations_user_source index only covers channel_id IS NULL rows.
	 */
	async findByContactAndSource(
		contactId: number,
		source: string,
	): Promise<ConversationRow | null> {
		const [row] = await this.ctx.db
			.select()
			.from(conversationsTable)
			.where(
				and(
					eq(conversationsTable.tenantId, this.ctx.tenantId),
					eq(conversationsTable.userId, contactId),
					eq(conversationsTable.source, source),
					isNull(conversationsTable.channelId),
				),
			);
		return (row as ConversationRow) ?? null;
	}

	/** Find a channel-aware conversation per (contactId, channelId). */
	async findByContactAndChannel(
		contactId: number,
		channelId: number,
	): Promise<ConversationRow | null> {
		const [row] = await this.ctx.db
			.select()
			.from(conversationsTable)
			.where(
				and(
					eq(conversationsTable.tenantId, this.ctx.tenantId),
					eq(conversationsTable.userId, contactId),
					eq(conversationsTable.channelId, channelId),
				),
			);
		return (row as ConversationRow) ?? null;
	}

	async create(opts: {
		contactId: number;
		source: string;
		channelId?: number | null;
		mode?: "ai" | "queued" | "human";
		styleId?: number | null;
		experimentId?: number | null;
		nowEpoch: number;
	}): Promise<ConversationRow> {
		const [row] = await this.ctx.db
			.insert(conversationsTable)
			.values({
				tenantId: this.ctx.tenantId,
				userId: opts.contactId,
				source: opts.source,
				...(opts.channelId !== undefined ? { channelId: opts.channelId } : {}),
				...(opts.mode ? { mode: opts.mode } : {}),
				...(opts.styleId !== undefined ? { styleId: opts.styleId } : {}),
				...(opts.experimentId !== undefined
					? { experimentId: opts.experimentId }
					: {}),
				lastMessageAt: opts.nowEpoch,
			})
			.returning();
		if (!row) throw new Error("conversations.create: insert returned no row");
		return row as ConversationRow;
	}

	/**
	 * Последние N conversations tenant'а, sorted DESC by last_message_at
	 * (NULLS LAST). Для admin-UI inbox.
	 */
	async recent(limit: number): Promise<ConversationRow[]> {
		const rows = await this.ctx.db
			.select()
			.from(conversationsTable)
			.where(eq(conversationsTable.tenantId, this.ctx.tenantId))
			.orderBy(sql`last_message_at DESC NULLS LAST`)
			.limit(limit);
		return rows as ConversationRow[];
	}

	async touchLastMessageAt(
		conversationId: number,
		nowEpoch: number,
	): Promise<void> {
		await this.ctx.db
			.update(conversationsTable)
			.set({ lastMessageAt: nowEpoch })
			.where(
				and(
					eq(conversationsTable.id, conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
				),
			);
	}

	/**
	 * Дедуп системных авто-сообщений «вне рабочих часов»: атомарно помечает время
	 * и возвращает true, если с прошлого авто-сообщения прошло ≥ minGapSec.
	 * Атомарный UPDATE (без предварительного SELECT) исключает гонку при параллельных
	 * входящих. Параметр `key` сохранён для совместимости сигнатуры, сейчас используется
	 * только "offhours" → колонка offhours_last_auto_sent.
	 */
	async shouldSendAutoMessage(
		conversationId: number,
		_key: string,
		minGapSec: number,
		nowEpoch: number,
	): Promise<boolean> {
		const cutoff = nowEpoch - minGapSec;
		const rows = await this.ctx.db
			.update(conversationsTable)
			.set({ offhoursLastAutoSent: nowEpoch })
			.where(
				and(
					eq(conversationsTable.id, conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
					sql`(${conversationsTable.offhoursLastAutoSent} IS NULL OR ${conversationsTable.offhoursLastAutoSent} < ${cutoff})`,
				),
			)
			.returning({ id: conversationsTable.id });
		return rows.length > 0;
	}

	/**
	 * #627 — счётчик ПОДРЯД фолбэков бота. isFallback=true → инкремент,
	 * иначе сброс в 0. Атомарный UPDATE без предварительного SELECT устраняет
	 * гонку при параллельных обновлениях. Возвращает новое значение.
	 */
	async bumpFallbackStreak(
		conversationId: number,
		isFallback: boolean,
		_nowEpoch: number,
	): Promise<number> {
		const rows = await this.ctx.db
			.update(conversationsTable)
			.set({
				fallbackStreak: isFallback
					? sql`${conversationsTable.fallbackStreak} + 1`
					: sql`0`,
			})
			.where(
				and(
					eq(conversationsTable.id, conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
				),
			)
			.returning({ fallbackStreak: conversationsTable.fallbackStreak });
		return rows[0]?.fallbackStreak ?? 0;
	}

	/**
	 * Debounce: запланировать (или сбросить) отложенный ответ. `dueAtEpoch` =
	 * now + пауза; перезапись на каждое входящее/правку в окне «сбрасывает
	 * таймер». null — отменить запланированный ответ.
	 */
	async setReplyDueAt(
		conversationId: number,
		dueAtEpoch: number | null,
	): Promise<void> {
		await this.ctx.db
			.update(conversationsTable)
			.set({ replyDueAt: dueAtEpoch })
			.where(
				and(
					eq(conversationsTable.id, conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
				),
			);
	}

	/**
	 * Атомарно «забирает» диалоги с наступившим дедлайном отложенного ответа
	 * (reply_due_at <= now): сбрасывает reply_due_at → NULL и возвращает
	 * id/userId/channelId/mode/currentStage. UPDATE…RETURNING гарантирует, что
	 * пересекающиеся тики поллера не подхватят строку дважды. Строки mode≠'ai'
	 * (диалог ушёл к оператору) тоже очищаются — caller просто не генерит ответ.
	 */
	async claimDueReplies(nowEpoch: number): Promise<
		Array<{
			id: number;
			userId: number;
			channelId: number | null;
			mode: "ai" | "queued" | "human";
			currentStage: string | null;
		}>
	> {
		const rows = await this.ctx.db
			.update(conversationsTable)
			.set({ replyDueAt: null })
			.where(
				and(
					eq(conversationsTable.tenantId, this.ctx.tenantId),
					sql`${conversationsTable.replyDueAt} IS NOT NULL`,
					sql`${conversationsTable.replyDueAt} <= ${nowEpoch}`,
				),
			)
			.returning({
				id: conversationsTable.id,
				userId: conversationsTable.userId,
				channelId: conversationsTable.channelId,
				mode: conversationsTable.mode,
				currentStage: conversationsTable.currentStage,
			});
		return rows as Array<{
			id: number;
			userId: number;
			channelId: number | null;
			mode: "ai" | "queued" | "human";
			currentStage: string | null;
		}>;
	}

	async updateInboxMetadata(
		conversationId: number,
		opts: {
			lastMessageText?: string;
			lastMessageAt?: number;
			incrementUnread?: boolean;
			status?: "open" | "pending" | "resolved";
		},
	): Promise<void> {
		const updates: Partial<typeof conversationsTable.$inferInsert> = {};
		if (opts.lastMessageText !== undefined)
			updates.lastMessageText = opts.lastMessageText;
		if (opts.lastMessageAt !== undefined)
			updates.lastMessageAt = opts.lastMessageAt;
		if (opts.status !== undefined) updates.status = opts.status;

		await this.ctx.db
			.update(conversationsTable)
			.set({
				...updates,
				...(opts.incrementUnread
					? { unreadCount: sql`${conversationsTable.unreadCount} + 1` }
					: {}),
			})
			.where(
				and(
					eq(conversationsTable.id, conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
				),
			);
	}

	/**
	 * #632 — авто-закрытие: переводит в status='resolved' все не-resolved диалоги
	 * тенанта, у которых последнее сообщение раньше cutoff (epoch). Возвращает
	 * число закрытых. Оператор может переоткрыть вручную.
	 */
	async autoCloseIdle(cutoffEpoch: number): Promise<number> {
		const rows = await this.ctx.db
			.update(conversationsTable)
			.set({ status: "resolved" })
			.where(
				and(
					eq(conversationsTable.tenantId, this.ctx.tenantId),
					sql`status <> 'resolved'`,
					sql`${conversationsTable.lastMessageAt} IS NOT NULL`,
					sql`${conversationsTable.lastMessageAt} < ${cutoffEpoch}`,
				),
			)
			.returning({ id: conversationsTable.id });
		return rows.length;
	}

	async markAsRead(conversationId: number): Promise<void> {
		await this.ctx.db
			.update(conversationsTable)
			.set({ unreadCount: 0 })
			.where(
				and(
					eq(conversationsTable.id, conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
				),
			);
	}

	async setAssignee(
		conversationId: number,
		adminId: number | null,
	): Promise<void> {
		await this.ctx.db
			.update(conversationsTable)
			.set({ assignedAdminId: adminId })
			.where(
				and(
					eq(conversationsTable.id, conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
				),
			);
	}

	/** Persist the style / experiment chosen for this conversation turn. */
	async setAssignment(
		conversationId: number,
		assignment: { styleId?: number | null; experimentId?: number | null },
	): Promise<void> {
		const updates: Partial<typeof conversationsTable.$inferInsert> = {};
		if (assignment.styleId !== undefined) updates.styleId = assignment.styleId;
		if (assignment.experimentId !== undefined)
			updates.experimentId = assignment.experimentId;
		if (Object.keys(updates).length === 0) return;

		await this.ctx.db
			.update(conversationsTable)
			.set(updates)
			.where(
				and(
					eq(conversationsTable.id, conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
				),
			);
	}

	/** Сохранить сжатое резюме диалога (conversation compaction). */
	async setSummaryJson(
		conversationId: number,
		summaryJson: string,
	): Promise<void> {
		await this.ctx.db
			.update(conversationsTable)
			.set({ summaryJson })
			.where(
				and(
					eq(conversationsTable.id, conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
				),
			);
	}

	/** Загрузить conversation по ID. Null если не найдена (или другой tenant). */
	async findById(conversationId: number): Promise<ConversationRow | null> {
		const [row] = await this.ctx.db
			.select()
			.from(conversationsTable)
			.where(
				and(
					eq(conversationsTable.id, conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
				),
			);
		return (row as ConversationRow) ?? null;
	}

	/**
	 * #651 — найти диалог по топику форум-группы оператора (Telegram
	 * message_thread_id ↔ conversations.operator_thread_id). Используется, когда
	 * оператор пишет в топике: маршрутизируем его текст ТОМУ клиенту, чей диалог
	 * привязан к треду. Tenant-scoped — чужой тенант не вернёт строку.
	 */
	async findConversationByOperatorThread(
		threadId: number,
	): Promise<ConversationRow | null> {
		const [row] = await this.ctx.db
			.select()
			.from(conversationsTable)
			.where(
				and(
					eq(conversationsTable.tenantId, this.ctx.tenantId),
					eq(conversationsTable.operatorThreadId, threadId),
				),
			)
			.limit(1);
		return (row as ConversationRow) ?? null;
	}

	async applyAutoHandoff(input: {
		conversationId: number;
		reason: string;
		orderId?: number;
		stageSlug?: string;
		customerNoticeSent: boolean;
		nowEpoch: number;
	}): Promise<{ changed: boolean; reason: string } | null> {
		const [existing] = await this.ctx.db
			.select({
				mode: conversationsTable.mode,
				status: conversationsTable.status,
				escalatedAt: conversationsTable.escalatedAt,
			})
			.from(conversationsTable)
			.where(
				and(
					eq(conversationsTable.id, input.conversationId),
					eq(conversationsTable.tenantId, this.ctx.tenantId),
				),
			)
			.limit(1);
		if (!existing) return null;

		const changed =
			existing.mode !== "human" ||
			existing.status !== "pending" ||
			existing.escalatedAt == null;
		if (changed) {
			await this.ctx.db
				.update(conversationsTable)
				.set({
					mode: "human",
					status: "pending",
					escalatedAt: existing.escalatedAt ?? input.nowEpoch,
					lastMessageAt: input.nowEpoch,
				})
				.where(
					and(
						eq(conversationsTable.id, input.conversationId),
						eq(conversationsTable.tenantId, this.ctx.tenantId),
					),
				);
		}

		await this.ctx.db.insert(auditLog).values({
			tenantId: this.ctx.tenantId,
			adminId: null,
			action: "conversation.mode.auto_handoff",
			targetKind: "conversation",
			targetId: String(input.conversationId),
			detailsJson: JSON.stringify({
				from: existing.mode,
				to: "human",
				reason: input.reason,
				customerNoticeSent: input.customerNoticeSent,
				...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
				...(input.stageSlug ? { stageSlug: input.stageSlug } : {}),
			}),
			createdAt: input.nowEpoch,
		});

		return { changed, reason: input.reason };
	}
}
