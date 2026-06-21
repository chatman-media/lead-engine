import { afterEach, describe, expect, it } from "bun:test";
import { assertPublicUrl, isBlockedIpLiteral, SsrfError, safeFetch } from "./safe-fetch.ts";

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

describe("assertPublicUrl — extra branches", () => {
  it("публичный литеральный IP → resolves без DNS (line 119)", async () => {
    await expect(assertPublicUrl("http://8.8.8.8/")).resolves.toBeUndefined();
  });

  it("несуществующий домен → SsrfError dns resolution failed (line 131)", async () => {
    // .invalid — RFC 6761 гарантированно не резолвится.
    await expect(assertPublicUrl("http://nope.invalid/")).rejects.toThrow(SsrfError);
  });
});

describe("safeFetch — redirects", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("следует за редиректом на публичный адрес (lines 165-166)", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      if (n === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://1.1.1.1/next" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await safeFetch("http://8.8.8.8/");
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  it("слишком много редиректов → SsrfError (line 164)", async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://1.1.1.1/loop" },
      })) as unknown as typeof fetch;
    await expect(safeFetch("http://8.8.8.8/", undefined, { maxRedirects: 1 })).rejects.toThrow(
      "too many redirects",
    );
  });
});
