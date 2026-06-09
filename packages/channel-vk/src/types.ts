// Минимальный набор VK Callback API payload-типов, которыми пользуется MVP.
// Перед расширением media/keyboards сверяйте текущую спецификацию VK:
//   https://dev.vk.com/api/callback/getting-started
//   https://dev.vk.com/method/messages.send

export interface VkAttachment {
	type: string;
	[key: string]: unknown;
}

export interface VkMessage {
	id?: number;
	conversation_message_id?: number;
	date?: number;
	peer_id: number;
	from_id?: number;
	text?: string;
	out?: number;
	attachments?: VkAttachment[];
}

export interface VkMessageNewObject {
	message: VkMessage;
	client_info?: unknown;
}

export interface VkCallbackPayload {
	type: "confirmation" | "message_new" | string;
	group_id?: number;
	object?: VkMessageNewObject | unknown;
	secret?: string;
	event_id?: string;
	v?: string;
}

export interface VkApiEnvelope<T> {
	response?: T;
	error?: {
		error_code: number;
		error_msg: string;
		request_params?: Array<{ key: string; value: string }>;
	};
}
