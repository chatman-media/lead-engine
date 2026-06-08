import { describe, expect, it } from "bun:test";
import { UserbotChannelRegistry } from "./userbot-channel-registry.ts";

function fakeDb(rows: Array<Record<string, unknown>>) {
	return {
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					where: async () => rows,
				}),
			}),
		}),
	};
}

function fakeLog() {
	const warnings: Array<{ msg: string; ctx: unknown }> = [];
	return {
		warnings,
		log: {
			info: () => {},
			warn: (msg: string, ctx: unknown) => warnings.push({ msg, ctx }),
			error: () => {},
			debug: () => {},
		},
	};
}

describe("UserbotChannelRegistry", () => {
	it("skips active userbot rows without credentialsRef and logs why", async () => {
		const { log, warnings } = fakeLog();
		const registry = new UserbotChannelRegistry({
			apiId: 0,
			apiHash: "",
			masterKeyHex: "a".repeat(64),
			log: log as never,
		});
		let runnerStarted = false;
		registry.setRunnerFactory(async () => {
			runnerStarted = true;
		});

		await registry.loadFromDb(
			fakeDb([
				{
					channelId: 22,
					externalId: "userbot",
					credentialsRef: null,
					updatedAt: 1,
					tenantId: 8,
					tenantSlug: "demo",
				},
			]) as never,
		);

		expect(registry.size()).toBe(0);
		expect(registry.byChannelId(22)).toBeUndefined();
		expect(registry.byTenant(8)).toEqual([]);
		expect(registry.entries()).toEqual([]);
		expect(runnerStarted).toBe(false);
		expect(warnings[0]?.msg).toContain("no credentialsRef");
		await registry.closeAll();
	});

	it("reloadTenant is safe before loadFromDb", async () => {
		const { log } = fakeLog();
		const registry = new UserbotChannelRegistry({
			apiId: 0,
			apiHash: "",
			masterKeyHex: "a".repeat(64),
			log: log as never,
		});

		await registry.reloadTenant(8, "demo");
		expect(registry.size()).toBe(0);
	});

	it("logs decrypt failures for credentialed rows and keeps boot alive", async () => {
		const { log, warnings } = fakeLog();
		const registry = new UserbotChannelRegistry({
			apiId: 0,
			apiHash: "",
			masterKeyHex: "a".repeat(64),
			log: log as never,
		});

		await registry.loadFromDb(
			fakeDb([
				{
					channelId: 23,
					externalId: "userbot",
					credentialsRef: "telegram_session",
					updatedAt: 1,
					tenantId: 8,
					tenantSlug: "demo",
				},
			]) as never,
		);

		expect(registry.size()).toBe(0);
		expect(warnings[0]?.msg).toBe("failed to decrypt userbot session");
	});

	it("closeAll aborts runners, closes adapters and clears indexes", async () => {
		const { log } = fakeLog();
		const registry = new UserbotChannelRegistry({
			apiId: 0,
			apiHash: "",
			masterKeyHex: "a".repeat(64),
			log: log as never,
		});
		let closed = 0;
		const abort = new AbortController();
		const internals = registry as unknown as {
			byChannelDbId: Map<
				number,
				{
					entry: {
						channelDbId: number;
						tenantId: number;
						tenantSlug: string;
						externalId: string;
						adapter: { close: () => Promise<void> };
					};
					updatedAt: number;
					abort: AbortController;
					runner: Promise<void>;
				}
			>;
		};
		internals.byChannelDbId.set(55, {
			entry: {
				channelDbId: 55,
				tenantId: 8,
				tenantSlug: "demo",
				externalId: "userbot",
				adapter: {
					close: async () => {
						closed += 1;
					},
				},
			},
			updatedAt: 1,
			abort,
			runner: Promise.resolve(),
		});

		expect(registry.size()).toBe(1);
		expect(registry.byChannelId(55)?.externalId).toBe("userbot");
		expect(registry.byTenant(8)).toHaveLength(1);
		expect(registry.entries()).toHaveLength(1);

		await registry.closeAll();

		expect(closed).toBe(1);
		expect(abort.signal.aborted).toBe(true);
		expect(registry.size()).toBe(0);
	});
});
