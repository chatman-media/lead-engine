import { describe, expect, it } from "bun:test";
import { signWebhookPayload } from "./webhook-sign.ts";

describe("signWebhookPayload", () => {
  it("канонический HMAC-SHA256 тест-вектор", async () => {
    const sig = await signWebhookPayload("The quick brown fox jumps over the lazy dog", "key");
    expect(sig).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  it("детерминирован для одинакового входа", async () => {
    expect(await signWebhookPayload("body", "s")).toBe(await signWebhookPayload("body", "s"));
  });

  it("64 hex-символа", async () => {
    expect(await signWebhookPayload("x", "y")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("разный секрет или тело → разная подпись", async () => {
    expect(await signWebhookPayload("body", "s1")).not.toBe(await signWebhookPayload("body", "s2"));
    expect(await signWebhookPayload("b1", "s")).not.toBe(await signWebhookPayload("b2", "s"));
  });
});
