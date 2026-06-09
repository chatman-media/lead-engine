import type { VkApiEnvelope } from "./types.ts";

export type FetchLike = typeof fetch;

export interface VkClientOptions {
	/** Community access token with messages permission. */
	accessToken: string;
	/** API version. Keep explicit for reproducibility in tests and deploys. */
	apiVersion?: string;
	/** Override base URL for tests/proxies. Default "https://api.vk.com/method". */
	baseUrl?: string;
	fetch?: FetchLike;
}

export class VkApiError extends Error {
	constructor(
		public method: string,
		public statusCode: number,
		public description: string,
		public code?: number,
	) {
		super(
			`VK ${method} failed (${statusCode}${code !== undefined ? `/${code}` : ""}): ${description}`,
		);
		this.name = "VkApiError";
	}
}

export interface VkGroupInfo {
	id: number;
	name?: string;
	screenName?: string;
}

interface VkRawGroup {
	id: number;
	name?: string;
	screen_name?: string;
}

export class VkClient {
	private readonly accessToken: string;
	private readonly apiVersion: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: FetchLike;

	constructor(opts: VkClientOptions) {
		if (!opts.accessToken) throw new Error("VkClient: accessToken required");
		this.accessToken = opts.accessToken;
		this.apiVersion = opts.apiVersion ?? "5.199";
		this.baseUrl = (opts.baseUrl ?? "https://api.vk.com/method").replace(
			/\/{1,512}$/,
			"",
		);
		this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
	}

	private async call<T>(
		method: string,
		params: Record<string, string | number | boolean | undefined>,
	): Promise<T> {
		const body = new URLSearchParams();
		body.set("access_token", this.accessToken);
		body.set("v", this.apiVersion);
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined) continue;
			body.set(key, String(value));
		}
		const res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		const text = await res.text().catch(() => "");
		let parsed: VkApiEnvelope<T>;
		try {
			parsed = text ? (JSON.parse(text) as VkApiEnvelope<T>) : {};
		} catch {
			throw new VkApiError(method, res.status, text || "invalid json response");
		}
		if (!res.ok) {
			throw new VkApiError(method, res.status, text || "no body");
		}
		if (parsed.error) {
			throw new VkApiError(
				method,
				res.status,
				parsed.error.error_msg,
				parsed.error.error_code,
			);
		}
		if (parsed.response === undefined) {
			throw new VkApiError(method, res.status, "no response in body");
		}
		return parsed.response;
	}

	/**
	 * Validate community token/group id. `groups.getById` is enough for the MVP:
	 * it proves the token can call VK API and the group exists.
	 */
	async getGroupInfo(groupId: string | number): Promise<VkGroupInfo> {
		const response = await this.call<VkRawGroup[] | { groups?: VkRawGroup[] }>(
			"groups.getById",
			{ group_id: groupId },
		);
		const groups = Array.isArray(response) ? response : (response.groups ?? []);
		const group = groups[0];
		if (!group?.id)
			throw new VkApiError("groups.getById", 200, "group not found");
		return {
			id: group.id,
			...(group.name ? { name: group.name } : {}),
			...(group.screen_name ? { screenName: group.screen_name } : {}),
		};
	}

	async sendText(input: {
		peerId: string | number;
		text: string;
		randomId?: number;
	}): Promise<{ messageId: string }> {
		const response = await this.call<number>("messages.send", {
			peer_id: input.peerId,
			message: input.text,
			random_id: input.randomId ?? Math.floor(Math.random() * 2_147_483_647),
		});
		return { messageId: String(response) };
	}

	async markAsRead(peerId: string | number): Promise<void> {
		await this.call<number>("messages.markAsRead", { peer_id: peerId });
	}

	async downloadMedia(url: string): Promise<Response> {
		const res = await this.fetchImpl(url, {});
		if (!res.ok) {
			throw new VkApiError(
				"downloadMedia",
				res.status,
				await res.text().catch(() => "no body"),
			);
		}
		return res;
	}
}
