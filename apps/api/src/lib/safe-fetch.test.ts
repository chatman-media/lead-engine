import { describe, expect, it } from "bun:test";
import { assertPublicUrl, isBlockedIpLiteral, SsrfError } from "./safe-fetch.ts";

describe("isBlockedIpLiteral", () => {
	const blocked = [
		"127.0.0.1",
		"169.254.169.254", // cloud metadata
		"10.0.0.5",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"100.64.0.1", // CGNAT
		"0.0.0.0",
		"::1",
		"fe80::1", // link-local
		"fc00::1", // unique-local
		"fd12:3456::1",
		"::ffff:127.0.0.1", // IPv4-mapped loopback
		"::ffff:169.254.169.254",
	];
	for (const ip of blocked) {
		it(`blocks ${ip}`, () => expect(isBlockedIpLiteral(ip)).toBe(true));
	}

	const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"];
	for (const ip of allowed) {
		it(`allows ${ip}`, () => expect(isBlockedIpLiteral(ip)).toBe(false));
	}

	it("returns false for non-IP strings", () => {
		expect(isBlockedIpLiteral("example.com")).toBe(false);
	});
});

describe("assertPublicUrl", () => {
	const expectBlocked = async (url: string) => {
		await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(SsrfError);
	};

	it("rejects non-http(s) protocols", async () => {
		await expectBlocked("file:///etc/passwd");
		await expectBlocked("gopher://127.0.0.1");
		await expectBlocked("ftp://example.com");
	});

	it("rejects literal private/loopback/link-local IPs", async () => {
		await expectBlocked("http://127.0.0.1/");
		await expectBlocked("http://169.254.169.254/latest/meta-data/");
		await expectBlocked("http://10.0.0.1:8080/internal");
		await expectBlocked("http://[::1]/");
		await expectBlocked("http://[fe80::1]/");
	});

	it("rejects localhost-style hostnames without DNS", async () => {
		await expectBlocked("http://localhost/");
		await expectBlocked("http://foo.localhost/");
		await expectBlocked("http://db.internal/");
	});

	it("rejects malformed urls", async () => {
		await expectBlocked("not a url");
	});

	it("allows a public DNS name", async () => {
		// example.com resolves to public IPs.
		await expect(assertPublicUrl("https://example.com/")).resolves.toBeUndefined();
	});
});
