import { describe, expect, it } from "bun:test";
import {
	verifyIpnKey,
	westWalletIpnToken,
	withIpnKey,
} from "./westwallet-ipn.ts";

const MASTER = "0123456789abcdef0123456789abcdef";

describe("westwallet-ipn", () => {
	it("derives a stable per-tenant token", () => {
		const a = westWalletIpnToken(42, MASTER);
		const b = westWalletIpnToken(42, MASTER);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{32}$/);
	});

	it("derives different tokens per tenant and per master key", () => {
		expect(westWalletIpnToken(1, MASTER)).not.toBe(westWalletIpnToken(2, MASTER));
		expect(westWalletIpnToken(1, MASTER)).not.toBe(
			westWalletIpnToken(1, "ffffffffffffffffffffffffffffffff"),
		);
	});

	it("embeds the key into an IPN URL as ?key=", () => {
		const url = withIpnKey("https://api.example.com/webhook/westwallet/42", 42, MASTER);
		const parsed = new URL(url);
		expect(parsed.searchParams.get("key")).toBe(westWalletIpnToken(42, MASTER));
	});

	it("verifies the embedded key round-trip", () => {
		const url = withIpnKey("https://api.example.com/webhook/westwallet/7", 7, MASTER);
		const key = new URL(url).searchParams.get("key") ?? "";
		expect(verifyIpnKey(key, 7, MASTER)).toBe(true);
	});

	it("rejects wrong / missing / cross-tenant keys", () => {
		const key7 = westWalletIpnToken(7, MASTER);
		expect(verifyIpnKey(key7, 8, MASTER)).toBe(false); // wrong tenant
		expect(verifyIpnKey("", 7, MASTER)).toBe(false); // missing
		expect(verifyIpnKey("deadbeef", 7, MASTER)).toBe(false); // forged
		expect(verifyIpnKey(key7, 7, "")).toBe(false); // no master key
	});
});
