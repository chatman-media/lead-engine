import { describe, expect, test } from "bun:test";

import { parseMTProxy, parseMTProxyList } from "@/telegram/mtproxy.ts";

// 32 / 34 hex chars — shape-valid placeholders for the parser (real proxy
// secrets start with `dd` for faketls or `ee` for random padding). All
// chars are valid hex AND obviously fake `deadbeef` filler.
const SECRET_32 = "dddeadbeefdeadbeefdeadbeefdeadbe";
const SECRET_34 = "dddeadbeefdeadbeefdeadbeefdeadbeef";

describe("parseMTProxy", () => {
  test("parses host:port:secret triple", () => {
    const r = parseMTProxy(`proxy.example.com:443:${SECRET_32}`);
    expect(r).toEqual({
      ip: "proxy.example.com",
      port: 443,
      secret: SECRET_32,
      MTProxy: true,
    });
  });

  test("parses tg://proxy?server=...&port=...&secret=...", () => {
    const r = parseMTProxy(`tg://proxy?server=1.2.3.4&port=8888&secret=${SECRET_34}`);
    expect(r).toEqual({ ip: "1.2.3.4", port: 8888, secret: SECRET_34, MTProxy: true });
  });

  test("parses https://t.me/proxy?...", () => {
    const r = parseMTProxy(`https://t.me/proxy?server=p.tg&port=443&secret=${SECRET_32}`);
    expect(r?.ip).toBe("p.tg");
    expect(r?.port).toBe(443);
  });

  test("accepts ee-prefixed secrets (random padding mode)", () => {
    const eeSecret = `ee${SECRET_32.slice(2)}`;
    const r = parseMTProxy(`host:443:${eeSecret}`);
    expect(r?.secret).toBe(eeSecret);
  });

  test("accepts FakeTLS / domain-fronted secrets (long hex with appended SNI bytes)", () => {
    // Shape from real-world community lists: `ee` flag + 16-byte secret +
    // ASCII-hex of the fronted hostname (here `bisotti.yektanet.com`).
    const fakeTlsSecret =
      "ee1603010200010001fc030386e24c3add626973636f7474692e79656b74616e65742e636f6d";
    const r = parseMTProxy(`total.beyondeson-co.cfd:443:${fakeTlsSecret}`);
    expect(r?.secret).toBe(fakeTlsSecret);
  });

  test("accepts base64-url encoded secrets (some clients emit this form)", () => {
    const b64Secret = "eeNEgYdJvXrFGRMCIMJdCQRueWVrdGFuZXQuY29tZmFyYWthdi5jb20=";
    const r = parseMTProxy(`weblog.forwarding-co.site:443:${b64Secret}`);
    expect(r?.secret).toBe(b64Secret);
  });

  test("accepts URL with extra params (e.g. &user=…) that aren't server/port/secret", () => {
    // Some clients append `&user=@handle` for attribution — must be ignored,
    // not break parsing.
    const r = parseMTProxy(
      `https://t.me/proxy?server=1.2.3.4&port=443&secret=${SECRET_32}&user=%40Guesswhaat`,
    );
    expect(r?.ip).toBe("1.2.3.4");
    expect(r?.secret).toBe(SECRET_32);
  });

  test("trims surrounding whitespace", () => {
    const r = parseMTProxy(`   host:443:${SECRET_32}   `);
    expect(r?.ip).toBe("host");
  });

  test("returns null for empty / whitespace-only input", () => {
    expect(parseMTProxy("")).toBeNull();
    expect(parseMTProxy("   ")).toBeNull();
  });

  test("returns null for wrong-shape colon strings", () => {
    expect(parseMTProxy("only:two")).toBeNull();
    expect(parseMTProxy("a:b:c:d")).toBeNull();
  });

  test("returns null for port out of range", () => {
    expect(parseMTProxy(`host:0:${SECRET_32}`)).toBeNull();
    expect(parseMTProxy(`host:99999:${SECRET_32}`)).toBeNull();
    expect(parseMTProxy(`host:abc:${SECRET_32}`)).toBeNull();
  });

  test("returns null for too-short / too-long / charset-violating secret", () => {
    // Too short — well under the 30-char floor that covers every real shape.
    expect(parseMTProxy("host:443:dead")).toBeNull();
    // Way over the 300-char ceiling (longest real-world FakeTLS secrets
    // we've observed are ~250 chars).
    expect(parseMTProxy(`host:443:${"a".repeat(320)}`)).toBeNull();
    // Spaces and punctuation aren't in either accepted charset (hex OR base64-url).
    expect(parseMTProxy(`host:443:has spaces and !exclaim chars`)).toBeNull();
  });

  test("returns null for hostname with garbage chars", () => {
    expect(parseMTProxy(`bad host:443:${SECRET_32}`)).toBeNull();
    expect(parseMTProxy(`bad/host:443:${SECRET_32}`)).toBeNull();
  });

  test("returns null for URL missing one of server/port/secret", () => {
    expect(parseMTProxy("tg://proxy?server=h&port=443")).toBeNull();
    expect(parseMTProxy(`tg://proxy?port=443&secret=${SECRET_32}`)).toBeNull();
    expect(parseMTProxy(`tg://proxy?server=h&secret=${SECRET_32}`)).toBeNull();
  });

  test("returns null for tg:// that isn't a proxy link", () => {
    expect(parseMTProxy(`tg://join?invite=abc`)).toBeNull();
  });

  test("returns null for https that isn't t.me/proxy", () => {
    expect(
      parseMTProxy(`https://example.com/proxy?server=h&port=443&secret=${SECRET_32}`),
    ).toBeNull();
    expect(parseMTProxy(`https://t.me/joinchat/abc`)).toBeNull();
  });

  test("returns null for unparseable garbage", () => {
    expect(parseMTProxy("https://")).toBeNull();
    expect(parseMTProxy("not a url and not a triple")).toBeNull();
  });
});

describe("parseMTProxyList", () => {
  test("parses a newline-separated list, mixing URL and triple formats", () => {
    const raw = [
      `host-1.example.com:443:${SECRET_32}`,
      `https://t.me/proxy?server=1.2.3.4&port=2053&secret=${SECRET_34}`,
      `tg://proxy?server=5.6.7.8&port=443&secret=${SECRET_32}`,
    ].join("\n");
    const { proxies, invalid_lines } = parseMTProxyList(raw);
    expect(proxies.length).toBe(3);
    expect(invalid_lines).toEqual([]);
    expect(proxies.map((p) => p.ip)).toEqual(["host-1.example.com", "1.2.3.4", "5.6.7.8"]);
  });

  test("skips blank lines and `#`-prefixed comments", () => {
    const raw = [
      "# my proxy list — refreshed daily",
      "",
      `host-a:443:${SECRET_32}`,
      "    ",
      "# next one is the backup",
      `host-b:443:${SECRET_34}`,
      "",
    ].join("\n");
    const { proxies, invalid_lines } = parseMTProxyList(raw);
    expect(proxies.length).toBe(2);
    expect(invalid_lines).toEqual([]);
    expect(proxies.map((p) => p.ip)).toEqual(["host-a", "host-b"]);
  });

  test("collects line numbers of unparseable entries instead of throwing", () => {
    const raw = [
      `host-1:443:${SECRET_32}`, // line 1 — ok
      "garbage entry", // line 2 — bad
      `host-3:443:${SECRET_34}`, // line 3 — ok
      "https://t.me/proxy?server=h", // line 4 — bad (missing port/secret)
    ].join("\n");
    const { proxies, invalid_lines } = parseMTProxyList(raw);
    expect(proxies.length).toBe(2);
    expect(invalid_lines).toEqual([2, 4]);
  });

  test("handles CRLF and LF mixed", () => {
    const raw = `host-a:443:${SECRET_32}\r\nhost-b:443:${SECRET_34}\n`;
    const { proxies } = parseMTProxyList(raw);
    expect(proxies.length).toBe(2);
  });

  test("empty input returns empty arrays (not null/undefined)", () => {
    expect(parseMTProxyList("")).toEqual({ proxies: [], invalid_lines: [] });
    expect(parseMTProxyList("\n\n# only comments\n\n")).toEqual({
      proxies: [],
      invalid_lines: [],
    });
  });
});
