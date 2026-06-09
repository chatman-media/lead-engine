import { describe, expect, it } from "bun:test";
import { type FetchLike, VkApiError, VkClient } from "./client.ts";

interface MockCall {
	url: string;
	init?: RequestInit;
}

function mockFetch(
	handler: (
		url: string,
		init?: RequestInit,
	) => { status?: number; body?: unknown; text?: string },
	calls?: MockCall[],
): FetchLike {
	return (async (url: string, init?: RequestInit) => {
		calls?.push({ url, init });
		const r = handler(url, init);
		const status = r.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => r.body ?? {},
			text: async () => r.text ?? JSON.stringify(r.body ?? {}),
		} as Response;
	}) as unknown as FetchLike;
}

describe("VkClient", () => {
	it("requires accessToken", () => {
		expect(() => new VkClient({ accessToken: "" })).toThrow(
			/accessToken required/,
		);
	});

	it("getGroupInfo calls groups.getById with token and version", async () => {
		const calls: MockCall[] = [];
		const c = new VkClient({
			accessToken: "tok",
			fetch: mockFetch(
				() => ({
					body: { response: [{ id: 123, name: "Acme", screen_name: "acme" }] },
				}),
				calls,
			),
		});
		await expect(c.getGroupInfo("123")).resolves.toEqual({
			id: 123,
			name: "Acme",
			screenName: "acme",
		});
		expect(calls[0]?.url).toBe("https://api.vk.com/method/groups.getById");
		const body = calls[0]?.init?.body as URLSearchParams;
		expect(body.get("access_token")).toBe("tok");
		expect(body.get("v")).toBe("5.199");
		expect(body.get("group_id")).toBe("123");
	});

	it("getGroupInfo accepts object response shape", async () => {
		const c = new VkClient({
			accessToken: "tok",
			fetch: mockFetch(() => ({
				body: { response: { groups: [{ id: 456, name: "Beta" }] } },
			})),
		});
		await expect(c.getGroupInfo("456")).resolves.toEqual({
			id: 456,
			name: "Beta",
		});
	});

	it("sendText calls messages.send with peer_id/message/random_id", async () => {
		const calls: MockCall[] = [];
		const c = new VkClient({
			accessToken: "tok",
			fetch: mockFetch(() => ({ body: { response: 777 } }), calls),
		});
		await expect(
			c.sendText({ peerId: "42", text: "hi", randomId: 9 }),
		).resolves.toEqual({
			messageId: "777",
		});
		expect(calls[0]?.url).toBe("https://api.vk.com/method/messages.send");
		const body = calls[0]?.init?.body as URLSearchParams;
		expect(body.get("peer_id")).toBe("42");
		expect(body.get("message")).toBe("hi");
		expect(body.get("random_id")).toBe("9");
	});

	it("VK error envelope throws VkApiError", async () => {
		const c = new VkClient({
			accessToken: "tok",
			fetch: mockFetch(() => ({
				body: {
					error: { error_code: 5, error_msg: "User authorization failed" },
				},
			})),
		});
		await expect(c.getGroupInfo("1")).rejects.toThrow(VkApiError);
	});
});
