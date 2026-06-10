/**
 * Unit-тесты runPostInboundAutomation: общий пост-обработчик inbound-сообщений
 * (field extractor + service catalog runtime). Без БД — фейки с записью вызовов.
 */

import { describe, expect, it } from "bun:test";
import type { Inbound } from "@chatman-media/channel-core";
import type { Db } from "@chatman-media/conversation-engine";
import type { FieldExtractor } from "./field-extractor.ts";
import { runPostInboundAutomation } from "./post-inbound-automation.ts";
import type { ServiceCatalogRuntime } from "./service-catalog-runtime.ts";

const fakeDb = {} as Db;

function textInbound(text: string): Inbound {
	return {
		channelId: "telegram",
		externalUserId: "u1",
		externalMessageId: "m1",
		parts: [{ kind: "text", text }],
		receivedAt: 1,
		raw: {},
	};
}

function mediaOnlyInbound(): Inbound {
	return {
		channelId: "telegram",
		externalUserId: "u1",
		externalMessageId: "m2",
		parts: [
			{
				kind: "photo",
				mediaRef: { channelId: "telegram", externalRef: "file-1" },
			},
		],
		receivedAt: 1,
		raw: {},
	};
}

function makeFieldExtractorSpy() {
	const calls: Array<Record<string, unknown>> = [];
	const extractor = {
		extract: async (args: Record<string, unknown>) => {
			calls.push(args);
			return { updated: [] };
		},
	} as unknown as FieldExtractor;
	return { extractor, calls };
}

function makeRuntimeSpy() {
	const calls: Array<Record<string, unknown>> = [];
	const runtime: ServiceCatalogRuntime = {
		extract: async (opts) => {
			calls.push(opts as unknown as Record<string, unknown>);
			return { created: [], skipped: [] };
		},
	};
	return { runtime, calls };
}

describe("runPostInboundAutomation", () => {
	it("вызывает field extractor и catalog runtime с правильными аргументами", async () => {
		const fe = makeFieldExtractorSpy();
		const rt = makeRuntimeSpy();
		await runPostInboundAutomation({
			db: fakeDb,
			tenantId: 5,
			contactId: 9,
			conversationId: 42,
			inbound: textInbound("нужен трансфер"),
			fieldExtractor: fe.extractor,
			serviceCatalogRuntime: rt.runtime,
		});
		expect(fe.calls).toHaveLength(1);
		expect(fe.calls[0]).toMatchObject({
			tenantId: 5,
			contactId: 9,
			text: "нужен трансфер",
		});
		expect(rt.calls).toHaveLength(1);
		expect(rt.calls[0]).toMatchObject({
			tenantId: 5,
			contactId: 9,
			conversationId: 42,
			text: "нужен трансфер",
		});
	});

	it("без conversationId runtime получает conversationId=null", async () => {
		const rt = makeRuntimeSpy();
		await runPostInboundAutomation({
			db: fakeDb,
			tenantId: 1,
			contactId: 2,
			inbound: textInbound("уборка"),
			serviceCatalogRuntime: rt.runtime,
		});
		expect(rt.calls[0]).toMatchObject({ conversationId: null });
	});

	it("inbound без текста → экстракторы не вызываются", async () => {
		const fe = makeFieldExtractorSpy();
		const rt = makeRuntimeSpy();
		await runPostInboundAutomation({
			db: fakeDb,
			tenantId: 1,
			contactId: 2,
			inbound: mediaOnlyInbound(),
			fieldExtractor: fe.extractor,
			serviceCatalogRuntime: rt.runtime,
		});
		expect(fe.calls).toHaveLength(0);
		expect(rt.calls).toHaveLength(0);
	});

	it("ошибки обоих экстракторов глотаются", async () => {
		const failingExtractor = {
			extract: async () => {
				throw new Error("extractor down");
			},
		} as unknown as FieldExtractor;
		const failingRuntime: ServiceCatalogRuntime = {
			extract: async () => {
				throw new Error("runtime down");
			},
		};
		await expect(
			runPostInboundAutomation({
				db: fakeDb,
				tenantId: 1,
				contactId: 2,
				inbound: textInbound("еда"),
				fieldExtractor: failingExtractor,
				serviceCatalogRuntime: failingRuntime,
			}),
		).resolves.toBeUndefined();
	});

	it("без экстракторов → no-op", async () => {
		await expect(
			runPostInboundAutomation({
				db: fakeDb,
				tenantId: 1,
				contactId: 2,
				inbound: textInbound("привет"),
				fieldExtractor: null,
				serviceCatalogRuntime: null,
			}),
		).resolves.toBeUndefined();
	});
});
