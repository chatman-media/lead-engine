import { describe, expect, it } from "bun:test";
import {
	type FetchLike,
	MaxApiError,
	MaxClient,
	parseMaxRecipient,
} from "./client.ts";

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
			text: async () => r.text ?? JSON.stringify(r.body ?? {}),
		} as Response;
	}) as unknown as FetchLike;
}

describe("MaxClient", () => {
	it("requires accessToken", () => {
		expect(() => new MaxClient({ accessToken: "" })).toThrow(
			/accessToken required/,
		);
	});

	it("parseMaxRecipient supports user/chat prefixes and bare user ids", () => {
		expect(parseMaxRecipient("user:42")).toEqual({ kind: "user", id: 42 });
		expect(parseMaxRecipient("chat:99")).toEqual({ kind: "chat", id: 99 });
		expect(parseMaxRecipient("123")).toEqual({ kind: "user", id: 123 });
		expect(() => parseMaxRecipient("bad")).toThrow(/invalid externalUserId/);
	});

	it("getBotInfo calls /me with Authorization header", async () => {
		const calls: MockCall[] = [];
		const c = new MaxClient({
			accessToken: "tok",
			fetch: mockFetch(
				() => ({
					body: {
						user_id: 123,
						username: "acme_bot",
						first_name: "Acme",
						is_bot: true,
					},
				}),
				calls,
			),
		});
		await expect(c.getBotInfo()).resolves.toEqual({
			user_id: 123,
			username: "acme_bot",
			first_name: "Acme",
			is_bot: true,
		});
		expect(calls[0]?.url).toBe("https://platform-api.max.ru/me");
		expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(
			"tok",
		);
	});

	it("sendText to user calls POST /messages?user_id=...", async () => {
		const calls: MockCall[] = [];
		const c = new MaxClient({
			accessToken: "tok",
			fetch: mockFetch(
				() => ({
					body: {
						message: { body: { mid: "m1" }, recipient: {}, timestamp: 1 },
					},
				}),
				calls,
			),
		});
		await expect(
			c.sendText({ externalUserId: "user:42", text: "hi" }),
		).resolves.toEqual({
			messageId: "m1",
		});
		expect(calls[0]?.url).toBe(
			"https://platform-api.max.ru/messages?user_id=42",
		);
		expect(calls[0]?.init?.method).toBe("POST");
		expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(
			"tok",
		);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: "hi" });
	});

	it("sendText to chat calls POST /messages?chat_id=...", async () => {
		const calls: MockCall[] = [];
		const c = new MaxClient({
			accessToken: "tok",
			fetch: mockFetch(
				() => ({
					body: {
						message: { body: { mid: "m2" }, recipient: {}, timestamp: 1 },
					},
				}),
				calls,
			),
		});
		await c.sendText({
			externalUserId: "chat:55",
			text: "hello",
			format: "markdown",
		});
		expect(calls[0]?.url).toBe(
			"https://platform-api.max.ru/messages?chat_id=55",
		);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			text: "hello",
			format: "markdown",
		});
	});

	it("throws MaxApiError on error response", async () => {
		const c = new MaxClient({
			accessToken: "tok",
			fetch: mockFetch(() => ({
				status: 401,
				body: { code: "verify.token", message: "Invalid access_token" },
			})),
		});
		await expect(c.getBotInfo()).rejects.toThrow(MaxApiError);
	});
});
