import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import {
  parseWhatsAppSignatureHeader,
  verifyWhatsAppSignature,
  WhatsAppSignatureError,
} from "./whatsapp-signature.ts";

const SECRET = "test-app-secret-12345";

function makeHeader(payload: string, secret = SECRET): string {
  const hex = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `sha256=${hex}`;
}

describe("parseWhatsAppSignatureHeader", () => {
  it("парсит валидный sha256= header", () => {
    const hex = "a".repeat(64);
    expect(parseWhatsAppSignatureHeader(`sha256=${hex}`)).toBe(hex);
  });

  it("trim whitespace", () => {
    const hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(parseWhatsAppSignatureHeader(`  sha256=${hex}  `)).toBe(hex);
  });

  it("нормализует uppercase hex до lowercase", () => {
    const hex = "ABCDEF0123456789".repeat(4);
    expect(parseWhatsAppSignatureHeader(`sha256=${hex}`)).toBe(hex.toLowerCase());
  });

  it("null/undefined → 'header missing'", () => {
    expect(() => parseWhatsAppSignatureHeader(null)).toThrow(WhatsAppSignatureError);
    expect(() => parseWhatsAppSignatureHeader(undefined)).toThrow(WhatsAppSignatureError);
    expect(() => parseWhatsAppSignatureHeader("")).toThrow(/header missing/);
  });

  it("без 'sha256=' префикса — reject (anti-bypass)", () => {
    const hex = "a".repeat(64);
    expect(() => parseWhatsAppSignatureHeader(hex)).toThrow(/expected sha256= prefix/);
  });

  it("неполный hex (короче 64) → reject", () => {
    expect(() => parseWhatsAppSignatureHeader("sha256=deadbeef")).toThrow(/malformed hex digest/);
  });

  it("не-hex символы → reject", () => {
    const bad = "g".repeat(64);
    expect(() => parseWhatsAppSignatureHeader(`sha256=${bad}`)).toThrow(/malformed hex digest/);
  });
});

describe("verifyWhatsAppSignature", () => {
  it("happy path: valid signature → success (void)", () => {
    const payload = '{"object":"whatsapp_business_account","entry":[]}';
    expect(() =>
      verifyWhatsAppSignature({
        secret: SECRET,
        payload,
        header: makeHeader(payload),
      }),
    ).not.toThrow();
  });

  it("tampered payload → signature mismatch", () => {
    const original = '{"object":"whatsapp_business_account","entry":[1]}';
    const header = makeHeader(original);
    expect(() =>
      verifyWhatsAppSignature({
        secret: SECRET,
        payload: '{"object":"whatsapp_business_account","entry":[2]}',
        header,
      }),
    ).toThrow(/signature mismatch/);
  });

  it("wrong secret → signature mismatch", () => {
    const payload = '{"any":"json"}';
    expect(() =>
      verifyWhatsAppSignature({
        secret: SECRET,
        payload,
        header: makeHeader(payload, "wrong-secret"),
      }),
    ).toThrow(/signature mismatch/);
  });

  it("missing header → throws", () => {
    expect(() =>
      verifyWhatsAppSignature({
        secret: SECRET,
        payload: "{}",
        header: undefined,
      }),
    ).toThrow(/header missing/);
  });

  it("malformed header (нет sha256= префикса) → throws", () => {
    expect(() =>
      verifyWhatsAppSignature({
        secret: SECRET,
        payload: "{}",
        header: "a".repeat(64),
      }),
    ).toThrow(/expected sha256= prefix/);
  });

  it("идентичные payload'ы с разным whitespace дают разные signatures (NB байт-точное сравнение)", () => {
    const a = '{"x":1}';
    const b = '{"x": 1}';
    const headerA = makeHeader(a);
    expect(() => verifyWhatsAppSignature({ secret: SECRET, payload: b, header: headerA })).toThrow(
      /signature mismatch/,
    );
  });

  it("error.reason поле программно доступно", () => {
    try {
      verifyWhatsAppSignature({
        secret: SECRET,
        payload: "{}",
        header: "bad-format",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsAppSignatureError);
      expect((err as WhatsAppSignatureError).reason).toBe("expected sha256= prefix");
    }
  });
});
