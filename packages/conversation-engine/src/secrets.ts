import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { tenantSecrets } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { Db } from "./dal/types.ts";

/**
 * AES-256-GCM шифрование для tenant_secrets.encrypted_value.
 *
 * Формат на disk: `iv_base64:auth_tag_base64:ciphertext_base64`. IV 12 байт
 * (GCM-рекомендованное), auth tag 16 байт, ciphertext — переменной длины.
 * Все три закодированы в base64 и склеены через `:` — TEXT-friendly.
 *
 * Master-key передаётся как hex (64 символа = 32 байта). Хранится вне БД —
 * в PLATFORM_MASTER_KEY env / secret manager. При ротации мастер-ключа
 * выполняется backfill миграция, перешифровывающая все строки tenant_secrets.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

export class SecretCryptoError extends Error {
  constructor(reason: string) {
    super(`SecretCrypto: ${reason}`);
    this.name = "SecretCryptoError";
  }
}

function masterKeyBytes(masterKeyHex: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(masterKeyHex)) {
    throw new SecretCryptoError("master key must be hex");
  }
  const buf = Buffer.from(masterKeyHex, "hex");
  if (buf.length !== 32) {
    throw new SecretCryptoError(
      `master key must be 32 bytes (64 hex chars), got ${buf.length}`,
    );
  }
  return buf;
}

export function encryptSecret(masterKeyHex: string, plaintext: string): string {
  const key = masterKeyBytes(masterKeyHex);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LEN) {
    throw new SecretCryptoError(`unexpected auth tag length ${authTag.length}`);
  }
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decryptSecret(masterKeyHex: string, ciphertext: string): string {
  const key = masterKeyBytes(masterKeyHex);
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new SecretCryptoError("ciphertext format must be iv:tag:payload");
  }
  const [ivB64, tagB64, payloadB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const payload = Buffer.from(payloadB64, "base64");
  if (iv.length !== IV_LEN) throw new SecretCryptoError("bad iv length");
  if (authTag.length !== AUTH_TAG_LEN) throw new SecretCryptoError("bad auth tag length");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    throw new SecretCryptoError("auth tag mismatch or corrupted ciphertext");
  }
}

// ---- DAL-like helpers поверх tenant_secrets таблицы --------------------

/**
 * Прочитать и расшифровать secret. Возвращает null если ключ не существует
 * для данного tenant'а. Бросает SecretCryptoError если ciphertext битый или
 * master-key неверный (auth tag mismatch).
 */
export async function getDecryptedSecret(opts: {
  db: Db;
  tenantId: number;
  key: string;
  masterKeyHex: string;
}): Promise<string | null> {
  const [row] = await opts.db
    .select()
    .from(tenantSecrets)
    .where(and(eq(tenantSecrets.tenantId, opts.tenantId), eq(tenantSecrets.key, opts.key)));
  if (!row) return null;
  return decryptSecret(opts.masterKeyHex, row.encryptedValue);
}

/** Upsert зашифрованного secret'а. */
export async function setEncryptedSecret(opts: {
  db: Db;
  tenantId: number;
  key: string;
  value: string;
  masterKeyHex: string;
  nowEpoch: number;
}): Promise<void> {
  const enc = encryptSecret(opts.masterKeyHex, opts.value);
  await opts.db
    .insert(tenantSecrets)
    .values({
      tenantId: opts.tenantId,
      key: opts.key,
      encryptedValue: enc,
      createdAt: opts.nowEpoch,
      updatedAt: opts.nowEpoch,
    })
    .onConflictDoUpdate({
      target: [tenantSecrets.tenantId, tenantSecrets.key],
      set: { encryptedValue: enc, updatedAt: opts.nowEpoch },
    });
}
