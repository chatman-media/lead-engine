import { describe, expect, it } from "bun:test";
import { UserbotOutboundDispatcher } from "./userbot-dispatcher.ts";
import { startUserbotInboundRunner } from "./userbot-inbound-runner.ts";
import { startWebInboundRunner } from "./web-inbound-runner.ts";

function fakeLog() {
	const errors: Array<{ msg: string; ctx: unknown }> = [];
	const warnings: Array<{ msg: string; ctx: unknown }> = [];
	return {
		errors,
		warnings,
		log: {
			info: () => {},
			debug: () => {},
			warn: (msg: string, ctx: unknown) => warnings.push({ msg, ctx }),
			error: (msg: string, ctx: unknown) => errors.push({ msg, ctx }),
		},
	};
}

async function* throwingReceive() {
	if (Date.now() < 0) yield undefined as never;
	throw new Error("receive down");
}

async function* emptyHealthEvents() {
	// completes immediately
}

describe("inbound runners", () => {
	it("logs unexpected web receive errors without throwing to caller", async () => {
		const { log, errors } = fakeLog();
		await startWebInboundRunner({
			entry: {
				channelDbId: 1,
				tenantId: 2,
				tenantSlug: "demo",
				externalId: "web",
				adapter: { receive: () => throwingReceive() } as never,
			},
			db: {} as never,
			signal: new AbortController().signal,
			log: log as never,
		});

		expect(errors[0]?.msg).toBe("web inbound runner exited");
	});

	it("logs unexpected userbot receive errors without throwing to caller", async () => {
		const { log, errors } = fakeLog();
		await startUserbotInboundRunner({
			entry: {
				channelDbId: 1,
				tenantId: 2,
				tenantSlug: "demo",
				externalId: "userbot",
				adapter: {
					receive: () => throwingReceive(),
					healthEvents: () => emptyHealthEvents(),
				} as never,
			},
			db: {} as never,
			signal: new AbortController().signal,
			log: log as never,
		});

		expect(errors[0]?.msg).toBe("userbot inbound runner exited");
	});
});

describe("UserbotOutboundDispatcher", () => {
	it("short-circuits tick when registry has no connected adapters", async () => {
		let queriedDb = false;
		const dispatcher = new UserbotOutboundDispatcher(
			{
				select: () => {
					queriedDb = true;
					return {};
				},
			} as never,
			{ size: () => 0 } as never,
			{
				pollMs: 1,
				batchSize: 10,
				log: fakeLog().log as never,
			},
		);

		await (dispatcher as unknown as { tick(): Promise<void> }).tick();
		expect(queriedDb).toBe(false);
	});
});
