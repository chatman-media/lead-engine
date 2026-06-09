import { describe, expect, it } from "bun:test";
import { MaxAdapter } from "./adapter.ts";
import type { MaxUpdate } from "./types.ts";

interface RecordedCall {
	url: string;
	method: string;
	body: string | null;
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>): {
	fetch: typeof fetch;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	let i = 0;
	const fn = async (
		url: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? init.body : null,
		});
		const resp = responses[i++] ?? { status: 200, body: {} };
		return new Response(JSON.stringify(resp.body), {
			status: resp.status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch: fn as unknown as typeof fetch, calls };
}

function adapter(fetchImpl: typeof globalThis.fetch): MaxAdapter {
	return new MaxAdapter({ id: "max1", accessToken: "TOK", fetch: fetchImpl });
}

describe("MaxAdapter", () => {
	it("send text -> POST /messages", async () => {
		const { fetch, calls } = fakeFetch([
			{
				status: 200,
				body: { message: { body: { mid: "m1" }, recipient: {}, timestamp: 1 } },
			},
		]);
		const a = adapter(fetch);
		const sent = await a.send({
			channelId: "max1",
			externalUserId: "user:555",
			parts: [{ kind: "text", text: "Привет" }],
		});
		expect(sent.externalMessageId).toBe("m1");
		expect(calls[0]?.url).toBe(
			"https://platform-api.max.ru/messages?user_id=555",
		);
		expect(calls[0]?.method).toBe("POST");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ text: "Привет" });
	});

	it("send with unsupported part throws", async () => {
		const { fetch } = fakeFetch([]);
		const a = adapter(fetch);
		await expect(
			a.send({
				channelId: "max1",
				externalUserId: "user:555",
				parts: [
					{ kind: "photo", mediaRef: { channelId: "max1", externalRef: "u" } },
				],
			}),
		).rejects.toThrow(/unsupported part/);
	});

	it("pushUpdate + receive gives inbound", async () => {
		const a = adapter(
			(async () => new Response("{}")) as unknown as typeof fetch,
		);
		const payload: MaxUpdate = {
			update_type: "message_created",
			timestamp: 1_700_000_000_000,
			message: {
				sender: { user_id: 555, username: "ivan", is_bot: false },
				recipient: { chat_id: 1, chat_type: "dialog" },
				timestamp: 1_700_000_000_000,
				body: { mid: "m1", text: "hi" },
			},
		};
		a.pushUpdate(payload);
		const iter = a.receive()[Symbol.asyncIterator]();
		const next = await iter.next();
		expect(next.done).toBe(false);
		expect(next.value.parts).toEqual([{ kind: "text", text: "hi" }]);
		expect(next.value.externalUserId).toBe("user:555");
		a.close();
	});

	it("capabilities are text-only for MVP", () => {
		const a = adapter(
			(async () => new Response("{}")) as unknown as typeof fetch,
		);
		expect(a.kind).toBe("max");
		expect(a.capabilities.text).toBe(true);
		expect(a.capabilities.photo).toBe(false);
		expect(a.capabilities.callbackQuery).toBe(false);
		expect(a.capabilities.edit).toBe(false);
	});
});
