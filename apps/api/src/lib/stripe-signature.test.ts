import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  parseSignatureHeader,
  StripeSignatureError,
  verifyStripeSignature,
} from "./stripe-signature.ts";

function sign(secret: string, payload: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

describe("parseSignatureHeader", () => {
  it("парсит valid header с t + v1", () => {
    const out = parseSignatureHeader("t=1700000000,v1=abc123");
    expect(out).toEqual({ timestamp: 1700000000, signatures: ["abc123"] });
  });

  it("собирает несколько v1 (rolling-rotation)", () => {
    const out = parseSignatureHeader("t=1700000000,v1=old,v1=new");
    expect(out.signatures).toEqual(["old", "new"]);
  });

  it("missing header → throws", () => {
    expect(() => parseSignatureHeader(null)).toThrow(StripeSignatureError);
    expect(() => parseSignatureHeader("")).toThrow(StripeSignatureError);
  });

  it("missing t= → throws", () => {
    expect(() => parseSignatureHeader("v1=abc")).toThrow(/no t=/);
  });

  it("missing v1= → throws", () => {
    expect(() => parseSignatureHeader("t=1700000000")).toThrow(/no v1=/);
  });
});

const SECRET = "whsec_test_keep_this_secret";

describe("verifyStripeSignature", () => {
  it("проходит на правильно подписанном payload'е", () => {
    const ts = 1700000000;
    const payload = '{"id":"evt_1","type":"customer.subscription.created"}';
    const sig = sign(SECRET, payload, ts);
    expect(() =>
      verifyStripeSignature({
        secret: SECRET,
        payload,
        header: `t=${ts},v1=${sig}`,
        nowEpoch: ts,
      }),
    ).not.toThrow();
  });

  it("rejected на изменённом payload'е (tampering)", () => {
    const ts = 1700000000;
    const payload = '{"id":"evt_1"}';
    const sig = sign(SECRET, payload, ts);
    expect(() =>
      verifyStripeSignature({
        secret: SECRET,
        payload: '{"id":"evt_2"}', // tampered
        header: `t=${ts},v1=${sig}`,
        nowEpoch: ts,
      }),
    ).toThrow(/no v1 signature matched/);
  });

  it("rejected на wrong secret", () => {
    const ts = 1700000000;
    const payload = "{}";
    const sig = sign("other_secret", payload, ts);
    expect(() =>
      verifyStripeSignature({
        secret: SECRET,
        payload,
        header: `t=${ts},v1=${sig}`,
        nowEpoch: ts,
      }),
    ).toThrow(/no v1 signature matched/);
  });

  it("rejected на старом timestamp'е (replay protection)", () => {
    const ts = 1700000000;
    const sig = sign(SECRET, "{}", ts);
    expect(() =>
      verifyStripeSignature({
        secret: SECRET,
        payload: "{}",
        header: `t=${ts},v1=${sig}`,
        nowEpoch: ts + 1000, // > 300s default tolerance
      }),
    ).toThrow(/outside tolerance/);
  });

  it("кастомный tolerance проходит", () => {
    const ts = 1700000000;
    const sig = sign(SECRET, "{}", ts);
    expect(() =>
      verifyStripeSignature({
        secret: SECRET,
        payload: "{}",
        header: `t=${ts},v1=${sig}`,
        nowEpoch: ts + 1000,
        toleranceSec: 2000,
      }),
    ).not.toThrow();
  });

  it("multiple v1: проходит если хоть один matches (rotation case)", () => {
    const ts = 1700000000;
    const payload = "{}";
    const oldSig = sign("old_secret", payload, ts);
    const newSig = sign(SECRET, payload, ts);
    expect(() =>
      verifyStripeSignature({
        secret: SECRET,
        payload,
        header: `t=${ts},v1=${oldSig},v1=${newSig}`,
        nowEpoch: ts,
      }),
    ).not.toThrow();
  });

  it("missing header → throws", () => {
    expect(() =>
      verifyStripeSignature({
        secret: SECRET,
        payload: "{}",
        header: null,
        nowEpoch: 1700000000,
      }),
    ).toThrow(/header missing/);
  });
});
