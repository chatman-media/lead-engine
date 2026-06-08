import { describe, expect, it } from "bun:test";
import { WebChannelRegistry } from "./web-channel-registry.ts";

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

describe("WebChannelRegistry", () => {
	it("loads active web channel rows and indexes them by tenant slug/channel id", async () => {
		const registry = new WebChannelRegistry();
		await registry.loadFromDb(
			fakeDb([
				{
					channelId: 11,
					externalId: "web-main",
					tenantId: 7,
					tenantSlug: "demo",
				},
			]) as never,
		);

		expect(registry.size()).toBe(1);
		expect(registry.byTenant("demo")?.channelDbId).toBe(11);
		expect(registry.byChannelId(11)?.tenantSlug).toBe("demo");
		expect(registry.entries()).toHaveLength(1);

		registry.closeAll();
		expect(registry.size()).toBe(0);
	});

	it("reloadTenant is a no-op before loadFromDb and replaces tenant entries after load", async () => {
		const registry = new WebChannelRegistry();
		await registry.reloadTenant(7, "demo");
		expect(registry.size()).toBe(0);

		await registry.loadFromDb(
			fakeDb([
				{
					channelId: 11,
					externalId: "old",
					tenantId: 7,
					tenantSlug: "demo",
				},
			]) as never,
		);
		await registry.reloadTenant(7, "demo");
		expect(registry.size()).toBe(1);
		expect(registry.byTenant("demo")?.externalId).toBe("old");
		registry.closeAll();
	});
});
