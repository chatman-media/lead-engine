import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, SecretCryptoError } from "./secrets.ts";

const masterKey = (): string => randomBytes(32).toString("hex");

describe("encryptSecret / decryptSecret", () => {
  it("round-trip восстанавливает оригинал", () => {
    const mk = masterKey();
    const plain = "sk-test-1234567890";
    const enc = encryptSecret(mk, plain);
    expect(decryptSecret(mk, enc)).toBe(plain);
  });

  it("каждый encrypt даёт уникальный ciphertext (random IV)", () => {
    const mk = masterKey();
    const a = encryptSecret(mk, "same");
    const b = encryptSecret(mk, "same");
    expect(a).not.toBe(b);
    expect(decryptSecret(mk, a)).toBe("same");
    expect(decryptSecret(mk, b)).toBe("same");
  });

  it("decrypt с неверным master-key — SecretCryptoError (auth tag mismatch)", () => {
    const mk1 = masterKey();
    const mk2 = masterKey();
    const enc = encryptSecret(mk1, "secret");
    expect(() => decryptSecret(mk2, enc)).toThrow(SecretCryptoError);
  });

  it("modified ciphertext → auth tag mismatch", () => {
    const mk = masterKey();
    const enc = encryptSecret(mk, "secret");
    const tampered = enc.replace(/.$/, "X");
    expect(() => decryptSecret(mk, tampered)).toThrow(SecretCryptoError);
  });

  it("работает с unicode (русский / эмодзи)", () => {
    const mk = masterKey();
    const plain = "Привет, 🌍! Это secret value.";
    expect(decryptSecret(mk, encryptSecret(mk, plain))).toBe(plain);
  });

  it("отвергает master-key неправильной длины", () => {
    expect(() => encryptSecret("deadbeef", "x")).toThrow(/32 bytes/);
  });

  it("отвергает не-hex master-key", () => {
    expect(() => encryptSecret("nothex!".padEnd(64, "z"), "x")).toThrow(/hex/);
  });

  it("отвергает ciphertext без 3 частей", () => {
    const mk = masterKey();
    expect(() => decryptSecret(mk, "not-a-valid-format")).toThrow(/iv:tag:payload/);
  });
});
