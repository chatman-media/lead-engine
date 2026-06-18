import type { TelegramClient } from "@chatman-media/channel-telegram";
import { conversations } from "@chatman-media/storage";
import { and, eq, isNull } from "drizzle-orm";
import { pickLeastBusyOperator } from "./assign-operator.ts";
import type { Db } from "./dal/types.ts";
import { withTenant } from "./with-tenant.ts";

/**
 * #651 — форум-топики оператора: 1 топик на диалог.
 *
 * Когда правило уведомлений ведёт в форум-группу (notification_rules
 * .target_is_forum = true), карточки разных клиентов больше не сыпятся в один
 * поток: для каждого диалога заводится отдельный Telegram-тред
 * (conversations.operator_thread_id) с понятным заголовком
 * («Иван · 500 USDT · #32 · занято: @operator»). Оператор пишет в топике →
 * ответ уходит ТОМУ клиенту (см. OperatorBotHandler.handleUpdate).
 *
 * Весь слой ADDITIVE: без db или без target_is_forum поведение прежнее
 * (единый чат, без топиков).
 */

export interface EnsuredOperatorTopic {
	/** message_thread_id топика — прокидывается в sendMessage. */
	threadId: number;
	/** true, если топик только что создан (для пула — назначаем оператора). */
	created: boolean;
}

/** Контекст карточки для имени топика. */
export interface OperatorTopicContext {
	conversationId: number;
	displayName?: string | null;
	/** «500 USDT» / направление — из data.amount, если есть. */
	amountLabel?: string | null;
}

function topicName(
	ctx: OperatorTopicContext,
	assignedOperator: string | null,
): string {
	const parts: string[] = [];
	const name = ctx.displayName?.trim();
	if (name) parts.push(name);
	const amount = ctx.amountLabel?.trim();
	if (amount) parts.push(amount);
	parts.push(`#${ctx.conversationId}`);
	if (assignedOperator) parts.push(`занято: ${assignedOperator}`);
	// Telegram ограничивает имя топика 128 символами.
	return parts.join(" · ").slice(0, 128);
}

/**
 * Гарантирует топик для диалога в форум-группе и (при первом создании) назначает
 * оператора по least-busy. Возвращает message_thread_id или null, если топик
 * нельзя завести (нет диалога / Telegram отказал — caller тогда шлёт в общий
 * чат без треда, как раньше).
 *
 * Идемпотентно по operator_thread_id: повторный handoff того же диалога
 * переиспользует существующий тред.
 */
export async function ensureOperatorTopic(input: {
	db: Db;
	client: TelegramClient;
	tenantId: number;
	chatId: string;
	context: OperatorTopicContext;
	nowEpoch: number;
}): Promise<EnsuredOperatorTopic | null> {
	const { db, client, tenantId, chatId, context, nowEpoch } = input;

	// 1. Уже есть тред? — переиспользуем (без создания/ассайна).
	const existing = await withTenant(db, tenantId, async (tx) => {
		const [row] = await tx
			.select({
				operatorThreadId: conversations.operatorThreadId,
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.tenantId, tenantId),
					eq(conversations.id, context.conversationId),
				),
			)
			.limit(1);
		return row ?? null;
	});
	if (!existing) return null;
	if (existing.operatorThreadId != null) {
		return { threadId: existing.operatorThreadId, created: false };
	}

	// 2. Пул: least-busy оператор (метка в имя топика + ассайн при создании).
	//    requireTelegram — оператору нужен привязанный чат для handoff.
	const operator = await withTenant(db, tenantId, (tx) =>
		pickLeastBusyOperator(tx, tenantId, { requireTelegram: true }),
	);

	// 3. Создаём топик в Telegram. Имя — контекст диалога.
	const topic = await client.createForumTopic({
		chatId,
		name: topicName(context, operator?.label ?? null),
	});

	// 4. Персистим thread id + (при наличии) ассайн оператора. Гонка двух
	//    параллельных handoff'ов: пишем только если тред ещё пуст; иначе
	//    переиспользуем уже записанный (наш топик осиротеет, но это безвредно).
	const persisted = await withTenant(db, tenantId, async (tx) => {
		const rows = await tx
			.update(conversations)
			.set({
				operatorThreadId: topic.message_thread_id,
				...(operator ? { assignedAdminId: operator.adminId } : {}),
				lastMessageAt: nowEpoch,
			})
			.where(
				and(
					eq(conversations.tenantId, tenantId),
					eq(conversations.id, context.conversationId),
					// только если ещё не привязан — иначе не перетираем чужой тред.
					isNull(conversations.operatorThreadId),
				),
			)
			.returning({ operatorThreadId: conversations.operatorThreadId });
		if (rows.length > 0) return topic.message_thread_id;

		// Кто-то записал тред раньше нас — переиспользуем его.
		const [row] = await tx
			.select({ operatorThreadId: conversations.operatorThreadId })
			.from(conversations)
			.where(
				and(
					eq(conversations.tenantId, tenantId),
					eq(conversations.id, context.conversationId),
				),
			)
			.limit(1);
		return row?.operatorThreadId ?? topic.message_thread_id;
	});

	return {
		threadId: persisted,
		created: persisted === topic.message_thread_id,
	};
}
