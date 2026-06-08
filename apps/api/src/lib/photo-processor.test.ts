import { describe, expect, it } from "bun:test";
import { makePhotoProcessor } from "./photo-processor.ts";

function photoInbound() {
	return {
		channelId: "channel",
		externalUserId: "user",
		externalMessageId: "msg",
		receivedAt: 1,
		parts: [
			{
				kind: "photo",
				mediaRef: { kind: "telegram_file", fileId: "file-1" },
			},
		],
		raw: {},
	};
}

describe("makePhotoProcessor", () => {
	it("does nothing when tenant has no vision config", async () => {
		let downloads = 0;
		const processor = makePhotoProcessor({
			current: {
				byTenant: new Map(),
				anyTenantHasChat: false,
				anyTenantHasEmbed: false,
			},
			router: {} as never,
		});

		await processor.process({
			tenantId: 1,
			inbound: photoInbound() as never,
			adapter: {
				downloadMedia: async () => {
					downloads += 1;
					return new Response("bytes");
				},
			} as never,
			contactId: 2,
			db: {} as never,
		});

		expect(downloads).toBe(0);
	});

	it("ignores unsupported vision providers before downloading media", async () => {
		let downloads = 0;
		const processor = makePhotoProcessor({
			current: {
				byTenant: new Map([
					[
						1,
						new Map([
							[
								"vision",
								{
									provider: "ollama",
									model: "llava",
									apiKey: "key",
								},
							],
						]),
					],
				]),
			},
		} as never);

		await processor.process({
			tenantId: 1,
			inbound: photoInbound() as never,
			adapter: {
				downloadMedia: async () => {
					downloads += 1;
					return new Response("bytes");
				},
			} as never,
			contactId: 2,
			db: {} as never,
		});

		expect(downloads).toBe(0);
	});

	it("returns before download when supported tenant config has no photo parts", async () => {
		let downloads = 0;
		const processor = makePhotoProcessor({
			current: {
				byTenant: new Map([
					[
						1,
						new Map([
							[
								"vision",
								{
									provider: "openai",
									model: "gpt-4o-mini",
									apiKey: "key",
								},
							],
						]),
					],
				]),
			},
		} as never);

		await processor.process({
			tenantId: 1,
			inbound: {
				...photoInbound(),
				parts: [{ kind: "text", text: "hello" }],
			} as never,
			adapter: {
				downloadMedia: async () => {
					downloads += 1;
					return new Response("bytes");
				},
			} as never,
			contactId: 2,
			db: {} as never,
		});

		expect(downloads).toBe(0);
	});

	it("swallows media download failures and continues without DB writes", async () => {
		let downloads = 0;
		const processor = makePhotoProcessor({
			current: {
				byTenant: new Map([
					[
						1,
						new Map([
							[
								"vision",
								{
									provider: "openrouter",
									model: "openai/gpt-4o-mini",
									apiKey: "key",
									baseUrl: "https://openrouter.test",
									timeoutMs: 100,
								},
							],
						]),
					],
				]),
			},
		} as never);

		await processor.process({
			tenantId: 1,
			inbound: photoInbound() as never,
			adapter: {
				downloadMedia: async () => {
					downloads += 1;
					throw new Error("download failed");
				},
			} as never,
			contactId: 2,
			db: {} as never,
		});

		expect(downloads).toBe(1);
	});
});
