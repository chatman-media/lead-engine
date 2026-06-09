// Минимальный набор MAX Bot API типов, которыми пользуется MVP.
// Сверено с dev.max.ru/docs-api и official max-bot-api-client-ts.

export interface MaxUser {
	user_id: number;
	name?: string;
	username?: string | null;
	is_bot?: boolean;
	last_activity_time?: number;
}

export type MaxChatType = "dialog" | "chat" | "channel" | string;

export interface MaxMessageRecipient {
	chat_id: number | null;
	chat_type: MaxChatType;
}

export interface MaxAttachment {
	type: string;
	payload?: Record<string, unknown> | null;
	[key: string]: unknown;
}

export interface MaxMessageBody {
	mid: string;
	seq?: number;
	text?: string | null;
	attachments?: MaxAttachment[] | null;
	markup?: unknown[] | null;
}

export interface MaxMessage {
	sender?: MaxUser | null;
	recipient: MaxMessageRecipient;
	timestamp: number;
	body: MaxMessageBody | null;
	link?: unknown;
	stat?: unknown;
	url?: string | null;
	constructor?: MaxUser | null;
}

export interface MaxMessageCreatedUpdate {
	update_type: "message_created";
	timestamp: number;
	message: MaxMessage;
	user_locale?: unknown;
}

export interface MaxBotStartedUpdate {
	update_type: "bot_started";
	timestamp: number;
	chat_id: number;
	user: MaxUser;
	payload?: string | null;
	user_locale?: unknown;
}

export interface MaxMessageCallbackUpdate {
	update_type: "message_callback";
	timestamp: number;
	callback: {
		timestamp: number;
		callback_id: string;
		payload?: string;
		user: MaxUser;
	};
	message?: MaxMessage | null;
	user_locale?: unknown;
}

export type MaxUpdate =
	| MaxMessageCreatedUpdate
	| MaxBotStartedUpdate
	| MaxMessageCallbackUpdate
	| ({ update_type: string; timestamp?: number } & Record<string, unknown>);

export interface MaxApiErrorBody {
	code?: string;
	message?: string;
	success?: false;
}
