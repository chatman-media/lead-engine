import { describe, expect, it } from "bun:test";
import { VkAdapter } from "./adapter.ts";
import type { VkCallbackPayload } from "./types.ts";

interface RecordedCall {
	url: string;
	method: string;
	body: URLSearchParams | null;
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
			body: init?.body instanceof URLSearchParams ? init.body : null,
		});
		const resp = responses[i++] ?? { status: 200, body: {} };
		return new Response(JSON.stringify(resp.body), {
			status: resp.status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch: fn as unknown as typeof fetch, calls };
}

function adapter(fetchImpl: typeof globalThis.fetch): VkAdapter {
	return new VkAdapter({ id: "vk1", accessToken: "TOK", fetch: fetchImpl });
}

describe("VkAdapter", () => {
	it("send text -> messages.send", async () => {
		const { fetch, calls } = fakeFetch([
			{ status: 200, body: { response: 111 } },
		]);
		const a = adapter(fetch);
		const sent = await a.send({
			channelId: "vk1",
			externalUserId: "555",
			parts: [{ kind: "text", text: "Привет" }],
		});
		expect(sent.externalMessageId).toBe("111");
		expect(calls[0]?.url).toBe("https://api.vk.com/method/messages.send");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body?.get("peer_id")).toBe("555");
		expect(calls[0]?.body?.get("message")).toBe("Привет");
	});

	it("send with unsupported part throws", async () => {
		const { fetch } = fakeFetch([]);
		const a = adapter(fetch);
		await expect(
			a.send({
				channelId: "vk1",
				externalUserId: "555",
				parts: [
					{ kind: "photo", mediaRef: { channelId: "vk1", externalRef: "u" } },
				],
			}),
		).rejects.toThrow(/unsupported part/);
	});

	it("pushUpdate + receive gives inbound", async () => {
		const a = adapter(
			(async () => new Response("{}")) as unknown as typeof fetch,
		);
		const payload: VkCallbackPayload = {
			type: "message_new",
			group_id: 1,
			object: {
				message: {
					id: 1,
					date: 1_700_000_000,
					peer_id: 555,
					from_id: 555,
					text: "hi",
				},
			},
		};
		a.pushUpdate(payload);
		const iter = a.receive()[Symbol.asyncIterator]();
		const next = await iter.next();
		expect(next.done).toBe(false);
		expect(next.value.parts).toEqual([{ kind: "text", text: "hi" }]);
		expect(next.value.externalUserId).toBe("555");
		a.close();
	});

	it("capabilities are text-only for MVP", () => {
		const a = adapter(
			(async () => new Response("{}")) as unknown as typeof fetch,
		);
		expect(a.kind).toBe("vk");
		expect(a.capabilities.text).toBe(true);
		expect(a.capabilities.photo).toBe(false);
		expect(a.capabilities.callbackQuery).toBe(false);
		expect(a.capabilities.edit).toBe(false);
	});
});
