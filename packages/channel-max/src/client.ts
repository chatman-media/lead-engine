import type {
	MaxApiErrorBody,
	MaxBotStartedUpdate,
	MaxMessage,
} from "./types.ts";

export type FetchLike = typeof fetch;

export interface MaxClientOptions {
	/** Bot token from business.max.ru → Chatbots → Integration → Get token. */
	accessToken: string;
	/** Override base URL for tests/proxies. Default "https://platform-api.max.ru". */
	baseUrl?: string;
	fetch?: FetchLike;
}

export interface MaxBotInfo {
	user_id: number;
	first_name?: string;
	last_name?: string | null;
	username?: string | null;
	is_bot: boolean;
	name?: string | null;
	description?: string | null;
}

export type MaxRecipient =
	| { kind: "user"; id: number }
	| { kind: "chat"; id: number };

export interface MaxSendTextInput {
	externalUserId: string;
	text: string;
	format?: "markdown" | "html";
}

export interface MaxSubscribeWebhookInput {
	url: string;
	updateTypes?: string[];
	secret?: string;
}

export class MaxApiError extends Error {
	constructor(
		public method: string,
		public statusCode: number,
		public description: string,
		public code?: string,
	) {
		super(
			`MAX ${method} failed (${statusCode}${code ? `/${code}` : ""}): ${description}`,
		);
		this.name = "MaxApiError";
	}
}

export function parseMaxRecipient(externalUserId: string): MaxRecipient {
	const raw = externalUserId.trim();
	const user = /^user:(\d{1,20})$/.exec(raw);
	if (user) return { kind: "user", id: Number(user[1]) };
	const chat = /^chat:(\d{1,20})$/.exec(raw);
	if (chat) return { kind: "chat", id: Number(chat[1]) };
	if (/^\d{1,20}$/.test(raw)) return { kind: "user", id: Number(raw) };
	throw new Error(`MAX: invalid externalUserId=${externalUserId}`);
}

export class MaxClient {
	private readonly accessToken: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: FetchLike;

	constructor(opts: MaxClientOptions) {
		if (!opts.accessToken) throw new Error("MaxClient: accessToken required");
		this.accessToken = opts.accessToken;
		this.baseUrl = (opts.baseUrl ?? "https://platform-api.max.ru").replace(
			/\/{1,512}$/,
			"",
		);
		this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
	}

	private url(
		path: string,
		query?: Record<string, string | number | boolean | undefined>,
	): string {
		const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined) continue;
			url.searchParams.set(key, String(value));
		}
		return url.href;
	}

	private async call<T>(
		method: string,
		path: string,
		init: RequestInit = {},
		query?: Record<string, string | number | boolean | undefined>,
	): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", this.accessToken);
		if (init.body && !headers.has("content-type"))
			headers.set("content-type", "application/json");

		const res = await this.fetchImpl(this.url(path, query), {
			...init,
			headers,
		});
		const text = await res.text().catch(() => "");
		let parsed: unknown = {};
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			throw new MaxApiError(
				method,
				res.status,
				text || "invalid json response",
			);
		}
		const body = parsed as MaxApiErrorBody;
		if (!res.ok || body.success === false) {
			throw new MaxApiError(
				method,
				res.status,
				body.message ?? text ?? "request failed",
				body.code,
			);
		}
		return parsed as T;
	}

	async getBotInfo(): Promise<MaxBotInfo> {
		const info = await this.call<MaxBotInfo>("getBotInfo", "/me", {
			method: "GET",
		});
		if (!info.user_id || !info.is_bot) {
			throw new MaxApiError(
				"getBotInfo",
				200,
				"token does not belong to a MAX bot",
			);
		}
		return info;
	}

	async sendText(input: MaxSendTextInput): Promise<{ messageId: string }> {
		const recipient = parseMaxRecipient(input.externalUserId);
		const query =
			recipient.kind === "user"
				? { user_id: recipient.id }
				: { chat_id: recipient.id };
		const response = await this.call<{ message: MaxMessage }>(
			"sendText",
			"/messages",
			{
				method: "POST",
				body: JSON.stringify({
					text: input.text,
					...(input.format ? { format: input.format } : {}),
				}),
			},
			query,
		);
		const id = response.message?.body?.mid;
		if (!id)
			throw new MaxApiError("sendText", 200, "no message.body.mid in response");
		return { messageId: id };
	}

	async subscribeWebhook(
		input: MaxSubscribeWebhookInput,
	): Promise<{ success: boolean }> {
		return this.call<{ success: boolean }>(
			"subscribeWebhook",
			"/subscriptions",
			{
				method: "POST",
				body: JSON.stringify({
					url: input.url,
					...(input.updateTypes ? { update_types: input.updateTypes } : {}),
					...(input.secret ? { secret: input.secret } : {}),
				}),
			},
		);
	}

	async downloadMedia(url: string): Promise<Response> {
		const res = await this.fetchImpl(url, {});
		if (!res.ok) {
			throw new MaxApiError(
				"downloadMedia",
				res.status,
				await res.text().catch(() => "no body"),
			);
		}
		return res;
	}

	async sendAction(input: {
		chatId: number;
		action: "typing_on" | "mark_seen";
	}): Promise<void> {
		await this.call<MaxBotStartedUpdate>(
			"sendAction",
			`/chats/${input.chatId}/actions`,
			{
				method: "POST",
				body: JSON.stringify({ action: input.action }),
			},
		);
	}
}
