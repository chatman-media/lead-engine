import type { ConversationRow, ConversationsRepo } from "./dal/index.ts";

/**
 * Маппинг ChannelKind → legacy conversations.source enum. До миграции
 * conversations.source → channel_id (отдельный коммит) держим этот
 * compat-shim, чтобы новый код писал в существующую колонку.
 */
function channelKindToSource(kind: string): "bot" | "userbot" | "self_play" {
	switch (kind) {
		case "telegram_bot":
			return "bot";
		case "telegram_userbot":
			return "userbot";
		case "self_play":
			// Симулированные диалоги (dev/тест): прогоняются через тот же
			// pipeline, но помечаются self_play — оператор видит их в инбоксе,
			// воркер реально в Telegram ничего не шлёт.
			return "self_play";
		default:
			// WhatsApp / web каналы временно записываются как 'bot' — после
			// миграции на channel_id колонку source перестанет существовать
			// и эта функция исчезнет.
			return "bot";
	}
}

/**
 * Find-or-create conversation для (contact, channel.kind). Уникальный
 * conversations.user_id × source гарантирует одну строку на канал.
 * Если контакт пишет одновременно в bot и userbot — получает две
 * независимые conversations.
 */
export async function resolveConversation(opts: {
	contactId: number;
	channelKind: string;
	conversations: ConversationsRepo;
	nowEpoch: number;
}): Promise<{ conversation: ConversationRow; created: boolean }> {
	const source = channelKindToSource(opts.channelKind);
	const existing = await opts.conversations.findByContactAndSource(
		opts.contactId,
		source,
	);
	if (existing) {
		return { conversation: existing, created: false };
	}
	const created = await opts.conversations.create({
		contactId: opts.contactId,
		source,
		mode: "ai",
		nowEpoch: opts.nowEpoch,
	});
	return { conversation: created, created: true };
}
