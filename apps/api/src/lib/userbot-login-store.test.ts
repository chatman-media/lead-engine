import { describe, expect, it, mock } from "bun:test";
import { UserbotLoginStore } from "./userbot-login-store.ts";

function fakeClient() {
	return { disconnect: mock(async () => {}) };
}

describe("UserbotLoginStore", () => {
	it("stores tenant-scoped pending logins and marks 2FA state", async () => {
		const store = new UserbotLoginStore({ ttlMs: 60_000 });
		const client = fakeClient();

		store.create({
			loginId: "login-1",
			client: client as never,
			phoneCodeHash: "hash",
			phone: "+660000000",
			tenantId: 10,
		});
		expect(store.size()).toBe(1);
		expect(store.get("login-1", 999)).toBeUndefined();
		expect(store.get("login-1", 10)?.phoneCodeHash).toBe("hash");

		store.markAwaiting2fa("login-1");
		expect(
			(store.get("login-1", 10) as { awaiting2fa: boolean } | undefined)
				?.awaiting2fa,
		).toBe(true);

		await store.discard("login-1");
		expect(store.size()).toBe(0);
		expect(client.disconnect).toHaveBeenCalledTimes(1);
		await store.stop();
	});

	it("drops expired entries and disconnects all clients on stop", async () => {
		const expired = new UserbotLoginStore({ ttlMs: -1 });
		const expiredClient = fakeClient();
		expired.create({
			loginId: "expired",
			client: expiredClient as never,
			phoneCodeHash: "hash",
			phone: "+660000001",
			tenantId: 10,
		});
		expect(expired.get("expired", 10)).toBeUndefined();
		expect(expired.size()).toBe(0);
		await expired.stop();

		const store = new UserbotLoginStore({ ttlMs: 60_000 });
		const first = fakeClient();
		const second = fakeClient();
		store.create({
			loginId: "a",
			client: first as never,
			phoneCodeHash: "a",
			phone: "+1",
			tenantId: 1,
		});
		store.create({
			loginId: "b",
			client: second as never,
			phoneCodeHash: "b",
			phone: "+2",
			tenantId: 2,
		});
		await store.stop();
		expect(store.size()).toBe(0);
		expect(first.disconnect).toHaveBeenCalledTimes(1);
		expect(second.disconnect).toHaveBeenCalledTimes(1);
	});

	it("discard ignores disconnect failures after removing the pending login", async () => {
		const store = new UserbotLoginStore({ ttlMs: 60_000 });
		await expect(store.discard("missing")).resolves.toBeUndefined();
		store.create({
			loginId: "fails-close",
			client: {
				disconnect: async () => {
					throw new Error("already closed");
				},
			} as never,
			phoneCodeHash: "hash",
			phone: "+660000002",
			tenantId: 10,
		});

		await expect(store.discard("fails-close")).resolves.toBeUndefined();
		expect(store.size()).toBe(0);
		await store.stop();
	});

	it("sweep discards expired pending logins", async () => {
		const store = new UserbotLoginStore({ ttlMs: -1 });
		const client = fakeClient();
		store.create({
			loginId: "expired-by-sweep",
			client: client as never,
			phoneCodeHash: "hash",
			phone: "+660000003",
			tenantId: 10,
		});

		await (store as unknown as { sweep(): Promise<void> }).sweep();

		expect(store.size()).toBe(0);
		expect(client.disconnect).toHaveBeenCalledTimes(1);
		await store.stop();
	});
});
