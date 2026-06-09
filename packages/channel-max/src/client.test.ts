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

	it("getBotInfo rejects non-bot tokens", async () => {
		const c = new MaxClient({
			accessToken: "tok",
			fetch: mockFetch(() => ({
				body: { user_id: 123, is_bot: false },
			})),
		});
		await expect(c.getBotInfo()).rejects.toThrow(/MAX bot/);
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
		expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe(
			"application/json",
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

	it("sendText throws when MAX response has no message id", async () => {
		const c = new MaxClient({
			accessToken: "tok",
			fetch: mockFetch(() => ({
				body: { message: { body: {}, recipient: {}, timestamp: 1 } },
			})),
		});
		await expect(
			c.sendText({ externalUserId: "user:42", text: "hi" }),
		).rejects.toThrow(/message\.body\.mid/);
	});

	it("subscribeWebhook posts URL, update types and secret", async () => {
		const calls: MockCall[] = [];
		const c = new MaxClient({
			accessToken: "tok",
			baseUrl: "https://max.example.test///",
			fetch: mockFetch(() => ({ body: { success: true } }), calls),
		});
		await expect(
			c.subscribeWebhook({
				url: "https://api.example.test/webhook/max/acme/778899",
				updateTypes: ["message_created"],
				secret: "max_secret",
			}),
		).resolves.toEqual({ success: true });
		expect(calls[0]?.url).toBe("https://max.example.test/subscriptions");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			url: "https://api.example.test/webhook/max/acme/778899",
			update_types: ["message_created"],
			secret: "max_secret",
		});
	});

	it("downloadMedia returns successful responses and throws on failures", async () => {
		const calls: MockCall[] = [];
		const c = new MaxClient({
			accessToken: "tok",
			fetch: (async (url: string | URL | Request) => {
				calls.push({ url: String(url) });
				if (String(url).includes("ok")) return new Response("bytes");
				return new Response("not found", { status: 404 });
			}) as FetchLike,
		});
		const ok = await c.downloadMedia("https://cdn.example.test/ok.jpg");
		expect(await ok.text()).toBe("bytes");
		await expect(
			c.downloadMedia("https://cdn.example.test/missing.jpg"),
		).rejects.toThrow(/downloadMedia failed \(404\)/);
		expect(calls.map((call) => call.url)).toEqual([
			"https://cdn.example.test/ok.jpg",
			"https://cdn.example.test/missing.jpg",
		]);
	});

	it("sendAction posts chat action", async () => {
		const calls: MockCall[] = [];
		const c = new MaxClient({
			accessToken: "tok",
			fetch: mockFetch(() => ({ body: { success: true } }), calls),
		});
		await c.sendAction({ chatId: 77, action: "typing_on" });
		expect(calls[0]?.url).toBe("https://platform-api.max.ru/chats/77/actions");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			action: "typing_on",
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

	it("throws MaxApiError on invalid JSON and success=false body", async () => {
		const invalidJson = new MaxClient({
			accessToken: "tok",
			fetch: mockFetch(() => ({ text: "not-json" })),
		});
		await expect(invalidJson.getBotInfo()).rejects.toThrow(MaxApiError);

		const failedBody = new MaxClient({
			accessToken: "tok",
			fetch: mockFetch(() => ({
				body: { success: false, code: "bad.request", message: "Bad request" },
			})),
		});
		await expect(
			failedBody.sendText({ externalUserId: "user:1", text: "x" }),
		).rejects.toThrow(/bad\.request/);
	});
});
