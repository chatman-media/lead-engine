// Facebook Messenger webhook signature verification. Meta использует тот же
// формат, что и WhatsApp Cloud — `X-Hub-Signature-256: sha256=<hex>`, где hex —
// HMAC-SHA256 от RAW request body с app_secret (Meta dashboard → App Settings →
// Basic). Без проверки любой может POST'ить fake payload'ы на
// /webhook/facebook/:slug.
//
// Отдельный файл (а не reuse whatsapp-signature) — чтобы каналы оставались
// независимыми (разные error-классы / метрики); сама крипта идентична.
//
// Docs: https://developers.facebook.com/docs/messenger-platform/webhooks#security

import { createHmac, timingSafeEqual } from "node:crypto";

export class FacebookSignatureError extends Error {
  constructor(public readonly reason: string) {
    super(`facebook signature invalid: ${reason}`);
    this.name = "FacebookSignatureError";
  }
}

/**
 * Парсит `X-Hub-Signature-256` header. Format: `sha256=<hex>`.
 * Возвращает hex-строку signature или throws.
 */
export function parseFacebookSignatureHeader(header: string | null | undefined): string {
  if (!header) throw new FacebookSignatureError("header missing");
  const trimmed = header.trim();
  // Meta всегда префиксит "sha256=". Без префикса — malformed; не пытаемся
  // «угадать» (иначе plain hex стал бы bypass-вектором).
  if (!trimmed.startsWith("sha256=")) {
    throw new FacebookSignatureError("expected sha256= prefix");
  }
  const hex = trimmed.slice("sha256=".length);
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== 64) {
    // SHA-256 hex digest — ровно 64 символа.
    throw new FacebookSignatureError("malformed hex digest");
  }
  return hex.toLowerCase();
}

export interface VerifyFacebookOptions {
  /** App secret из Meta dashboard. */
  secret: string;
  /** Raw request body как UTF-8 string (НЕ распарсенный JSON — байты должны совпадать). */
  payload: string;
  /** Содержимое X-Hub-Signature-256 header'а. */
  header: string | null | undefined;
}

/**
 * Верифицирует Facebook webhook signature. Возвращает void (success) или
 * бросает FacebookSignatureError. timing-safe compare против timing-атак.
 */
export function verifyFacebookSignature(opts: VerifyFacebookOptions): void {
  const gotHex = parseFacebookSignatureHeader(opts.header);
  const expectedHex = createHmac("sha256", opts.secret).update(opts.payload, "utf8").digest("hex");
  const gotBuf = Buffer.from(gotHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (gotBuf.length !== expectedBuf.length) {
    throw new FacebookSignatureError("digest length mismatch");
  }
  if (!timingSafeEqual(gotBuf, expectedBuf)) {
    throw new FacebookSignatureError("signature mismatch");
  }
}
