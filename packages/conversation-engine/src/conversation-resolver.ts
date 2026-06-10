import type { ConversationRow, ConversationsRepo } from "./dal/index.ts";

function channelKindToSource(kind: string): "bot" | "userbot" | "self_play" {
	switch (kind) {
		case "telegram_bot":
			return "bot";
		case "telegram_userbot":
			return "userbot";
		case "self_play":
			return "self_play";
		default:
			return "bot";
	}
}

/**
 * Find-or-create conversation для (contact, channel). New channel-aware path
 * uses conversations.channel_id, so WhatsApp/web/Facebook/VK no longer collapse
 * into legacy source='bot'. If channelId is absent, fall back to legacy
 * (contact, source) lookup for old tests/self-play callers.
 */
export async function resolveConversation(opts: {
	contactId: number;
	channelId?: number | null;
	channelKind: string;
	conversations: ConversationsRepo;
	nowEpoch: number;
}): Promise<{ conversation: ConversationRow; created: boolean }> {
	const source = channelKindToSource(opts.channelKind);
	if (opts.channelId !== undefined && opts.channelId !== null) {
		const existing = await opts.conversations.findByContactAndChannel(
			opts.contactId,
			opts.channelId,
		);
		if (existing) {
			return { conversation: existing, created: false };
		}
		const created = await opts.conversations.create({
			contactId: opts.contactId,
			channelId: opts.channelId,
			source,
			mode: "ai",
			nowEpoch: opts.nowEpoch,
		});
		return { conversation: created, created: true };
	}

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
