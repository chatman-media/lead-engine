/**
 * Unit tests for partner-ping callback token sign/verify.
 */
import { describe, it, expect } from "bun:test";
import { makeCallbackToken, verifyCallbackToken } from "./partner-ping.ts";

const SECRET = "test-secret-32-bytes-long-enough";

describe("partner-ping token", () => {
  it("roundtrips sign → verify", async () => {
    const payload = { leadId: 42, stageId: 7, ts: 1_700_000_000 };
    const token = await makeCallbackToken(payload, SECRET);
    expect(typeof token).toBe("string");
    expect(token.includes(".")).toBe(true);

    const result = await verifyCallbackToken(token, SECRET);
    expect(result).toEqual(payload);
  });

  it("rejects tampered token", async () => {
    const token = await makeCallbackToken({ leadId: 1, stageId: 2, ts: 100 }, SECRET);
    // flip one char in the HMAC part
    const parts = token.split(".");
    parts[1] = parts[1]!.slice(0, -1) + (parts[1]!.endsWith("a") ? "b" : "a");
    const tampered = parts.join(".");
    const result = await verifyCallbackToken(tampered, SECRET);
    expect(result).toBeNull();
  });

  it("rejects empty string", async () => {
    expect(await verifyCallbackToken("", SECRET)).toBeNull();
  });

  it("rejects token with wrong secret", async () => {
    const token = await makeCallbackToken({ leadId: 1, stageId: 2, ts: 100 }, SECRET);
    expect(await verifyCallbackToken(token, "different-secret")).toBeNull();
  });
});
