import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { log, newCorrelationId, redactPII, setLogLevel } from "@/log.ts";

describe("redactPII", () => {
  test("masks Telegram bot tokens", () => {
    const line = JSON.stringify({
      msg: "calling https://api.telegram.org/bot1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789/sendMessage",
    });
    expect(redactPII(line)).toContain("[REDACTED:tg-bot-token]");
    expect(redactPII(line)).not.toContain("1234567890:ABC");
  });

  test("masks OpenAI / OpenRouter / Anthropic / project API keys", () => {
    // Placeholder shape — secret-scan auto-allowlist tolerates XXXX/YYYY/ZZZZ.
    const cases = [
      "sk-XXXXXXXXXXXXXXXXXXXXXX",
      "sk-or-v1-YYYYYYYYYYYYYYYYYY",
      "sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ",
      "sk-proj-XXXXXXXXXXXXXXXXXXXX",
    ];
    for (const key of cases) {
      expect(redactPII(JSON.stringify({ k: key }))).toContain("[REDACTED:api-key]");
    }
  });

  test("masks phone numbers in E.164 and common separator formats", () => {
    const cases = ["+998 90 123-45-67", "+7 (495) 555-1234", "+44 20 7946 0958", "8-800-555-35-35"];
    for (const phone of cases) {
      const result = redactPII(JSON.stringify({ p: phone }));
      expect(result).toContain("[REDACTED:phone]");
    }
  });

  test("masks passport-shaped IDs (2 letters + 7 digits)", () => {
    const result = redactPII(JSON.stringify({ doc: "AB1234567" }));
    expect(result).toContain("[REDACTED:passport]");
  });

  test("leaves internal IDs alone (conversation_id, user_id, message_id)", () => {
    const line = JSON.stringify({
      conversation_id: 42,
      user_id: 9001,
      message_id: 123,
      tg_message_id: 4567,
    });
    expect(redactPII(line)).toBe(line);
  });

  test("leaves timestamps and short numbers alone", () => {
    const line = JSON.stringify({ ts: "2026-05-15T10:30:00Z", n: 1500, count: 3 });
    expect(redactPII(line)).toBe(line);
  });

  test("multiple PII items on one line each get masked", () => {
    const line = JSON.stringify({
      msg: "user +998901234567 had token sk-or-v1-XXXXXXXXXXXXXXXXXXXX",
    });
    const out = redactPII(line);
    expect(out).toContain("[REDACTED:phone]");
    expect(out).toContain("[REDACTED:api-key]");
  });
});

describe("logger emits JSON lines with redaction applied", () => {
  let captured: { stdout: string[]; stderr: string[] };
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    captured = { stdout: [], stderr: [] };
    origLog = console.log;
    origErr = console.error;
    console.log = (msg) => captured.stdout.push(String(msg));
    console.error = (msg) => captured.stderr.push(String(msg));
    setLogLevel("debug");
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    setLogLevel("info");
  });

  test("info writes one JSON line to stdout with ts/level/msg", () => {
    log.info("server start", { port: 3000 });
    expect(captured.stdout).toHaveLength(1);
    const evt = JSON.parse(captured.stdout[0]!);
    expect(evt.level).toBe("info");
    expect(evt.msg).toBe("server start");
    expect(evt.port).toBe(3000);
    expect(typeof evt.ts).toBe("string");
  });

  test("warn and error go to stderr", () => {
    log.warn("slow query", { ms: 800 });
    log.error("db dropped", { err_message: "ECONNRESET" });
    expect(captured.stdout).toHaveLength(0);
    expect(captured.stderr).toHaveLength(2);
  });

  test("child binds extra fields onto every emit", () => {
    const ch = log.child({ corr_id: "abc12345", conv_id: 42 });
    ch.info("processed");
    const evt = JSON.parse(captured.stdout[0]!);
    expect(evt.corr_id).toBe("abc12345");
    expect(evt.conv_id).toBe(42);
  });

  test("error called with an Error captures name+message+stack", () => {
    const err = new Error("nope");
    log.error("blew up", err);
    const evt = JSON.parse(captured.stderr[0]!);
    expect(evt.err_message).toBe("nope");
    expect(evt.err_name).toBe("Error");
    expect(typeof evt.err_stack).toBe("string");
  });

  test("error called with fields containing nested err hoists err_*", () => {
    log.error("style parse failed", { scope: "sales", style_id: 7, err: new Error("bad JSON") });
    const evt = JSON.parse(captured.stderr[0]!);
    expect(evt.scope).toBe("sales");
    expect(evt.style_id).toBe(7);
    expect(evt.err_message).toBe("bad JSON");
    expect(typeof evt.err_stack).toBe("string");
    expect(evt.err).toBeUndefined();
  });

  test("PII redaction runs on the emitted line", () => {
    log.info("auth complete", {
      phone: "+998 90 123 45 67",
      tg_token: "12345678:abcDEFghiJKLmnoPQRstuVWXyz0123456789",
    });
    const line = captured.stdout[0]!;
    expect(line).toContain("[REDACTED:phone]");
    expect(line).toContain("[REDACTED:tg-bot-token]");
    expect(line).not.toContain("+998 90 123 45 67");
  });
});

describe("newCorrelationId", () => {
  test("returns 8-hex-char string", () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("returns a different value each call (well, statistically)", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newCorrelationId()));
    // 100 8-hex draws colliding is ~1e-7; if it ever fires it's the RNG, not us.
    expect(ids.size).toBeGreaterThan(90);
  });
});
