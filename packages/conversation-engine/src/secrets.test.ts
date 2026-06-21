import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Db } from "./dal/types.ts";
import {
  decryptSecret,
  encryptSecret,
  getDecryptedSecret,
  SecretCryptoError,
  setEncryptedSecret,
} from "./secrets.ts";

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
    // Flip the final ciphertext nibble to a *different valid* hex digit so the
    // payload stays well-formed hex of the same length — the rejection must come
    // from the GCM auth-tag check, not from a hex-decode quirk on an invalid char.
    const tampered = enc.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
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

  it("decrypt с битым IV (неверная длина) → SecretCryptoError", () => {
    const mk = masterKey();
    // короткий IV (4 байта вместо 12) → "bad iv length"
    const badIv = Buffer.from([1, 2, 3, 4]).toString("base64");
    const tag = randomBytes(16).toString("base64");
    const payload = randomBytes(8).toString("base64");
    expect(() => decryptSecret(mk, `${badIv}:${tag}:${payload}`)).toThrow(/bad iv length/);
  });

  it("decrypt с битым auth tag (неверная длина) → SecretCryptoError", () => {
    const mk = masterKey();
    const iv = randomBytes(12).toString("base64");
    // короткий tag (8 байт вместо 16) → "bad auth tag length"
    const badTag = randomBytes(8).toString("base64");
    const payload = randomBytes(8).toString("base64");
    expect(() => decryptSecret(mk, `${iv}:${badTag}:${payload}`)).toThrow(/bad auth tag length/);
  });
});

describe("getDecryptedSecret / setEncryptedSecret (DAL helpers)", () => {
  function fakeSelectDb(rows: Array<{ encryptedValue: string }>): Db {
    return {
      select: () => ({
        from: () => ({
          where: async () => rows,
        }),
      }),
    } as unknown as Db;
  }

  it("getDecryptedSecret: строки нет → null", async () => {
    const out = await getDecryptedSecret({
      db: fakeSelectDb([]),
      tenantId: 1,
      key: "openai",
      masterKeyHex: masterKey(),
    });
    expect(out).toBeNull();
  });

  it("getDecryptedSecret: строка есть → расшифровывает", async () => {
    const mk = masterKey();
    const enc = encryptSecret(mk, "sk-secret-value");
    const out = await getDecryptedSecret({
      db: fakeSelectDb([{ encryptedValue: enc }]),
      tenantId: 1,
      key: "openai",
      masterKeyHex: mk,
    });
    expect(out).toBe("sk-secret-value");
  });

  it("setEncryptedSecret: шифрует и зовёт insert.onConflictDoUpdate", async () => {
    const mk = masterKey();
    let storedValue: unknown;
    const db = {
      insert: () => ({
        values: (row: { encryptedValue: string }) => {
          storedValue = row.encryptedValue;
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    } as unknown as Db;

    await setEncryptedSecret({
      db,
      tenantId: 7,
      key: "anthropic",
      value: "sk-ant-xyz",
      masterKeyHex: mk,
      nowEpoch: 1700000000,
    });
    // записан ciphertext, который расшифровывается обратно в исходное значение
    expect(typeof storedValue).toBe("string");
    expect(decryptSecret(mk, storedValue as string)).toBe("sk-ant-xyz");
  });
});
