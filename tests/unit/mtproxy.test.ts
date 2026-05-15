import { describe, expect, test } from "bun:test";

import { parseMTProxy } from "@/telegram/mtproxy.ts";

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

  test("returns null for non-hex / too-short secret", () => {
    expect(parseMTProxy("host:443:not-hex-at-all")).toBeNull();
    expect(parseMTProxy("host:443:dead")).toBeNull(); // too short (< 30)
    expect(parseMTProxy(`host:443:${"a".repeat(70)}`)).toBeNull(); // too long (> 68)
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
