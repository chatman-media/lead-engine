// WhatsApp Cloud webhook signature verification. Meta пробрасывает
// `X-Hub-Signature-256: sha256=<hex>` — HMAC-SHA256 от raw request body
// с app_secret (из Meta dashboard → App Settings → Basic). Без проверки
// любой может POST'ить fake payload'ы на /webhook/whatsapp/:slug.
//
// Формат проще чем у Stripe (нет timestamp, нет multi-signature rotation):
//   X-Hub-Signature-256: sha256=2c4e8a...
//
// Docs: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications

import { createHmac, timingSafeEqual } from "node:crypto";

export class WhatsAppSignatureError extends Error {
  constructor(public readonly reason: string) {
    super(`whatsapp signature invalid: ${reason}`);
    this.name = "WhatsAppSignatureError";
  }
}

/**
 * Парсит `X-Hub-Signature-256` header. Format: `sha256=<hex>`.
 * Возвращает hex-строку signature или throws.
 */
export function parseWhatsAppSignatureHeader(
  header: string | null | undefined,
): string {
  if (!header) throw new WhatsAppSignatureError("header missing");
  const trimmed = header.trim();
  // Meta всегда префиксит "sha256=". Если префикса нет — это malformed,
  // не пытаемся «угадать» (был бы attack vector — pass plain hex как
  // bypass).
  if (!trimmed.startsWith("sha256=")) {
    throw new WhatsAppSignatureError("expected sha256= prefix");
  }
  const hex = trimmed.slice("sha256=".length);
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== 64) {
    // SHA-256 hex digest — ровно 64 символов.
    throw new WhatsAppSignatureError("malformed hex digest");
  }
  return hex.toLowerCase();
}

export interface VerifyWhatsAppOptions {
  /** App secret из Meta dashboard. */
  secret: string;
  /** Raw request body как UTF-8 string (НЕ распарсенный JSON — байты должны совпадать). */
  payload: string;
  /** Содержимое X-Hub-Signature-256 header'а. */
  header: string | null | undefined;
}

/**
 * Верифицирует WhatsApp webhook signature. Возвращает void (success)
 * или бросает WhatsAppSignatureError. timing-safe compare против timing
 * attacks.
 *
 * Anti-replay protection (timestamp tolerance как у Stripe) — Meta НЕ
 * отдаёт timestamp в header'е, поэтому встроенной защиты нет. Если
 * нужна — добавить idempotency-store на (entry.id + change.value.metadata.id).
 */
export function verifyWhatsAppSignature(opts: VerifyWhatsAppOptions): void {
  const gotHex = parseWhatsAppSignatureHeader(opts.header);
  const expectedHex = createHmac("sha256", opts.secret)
    .update(opts.payload, "utf8")
    .digest("hex");
  const gotBuf = Buffer.from(gotHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (gotBuf.length !== expectedBuf.length) {
    throw new WhatsAppSignatureError("digest length mismatch");
  }
  if (!timingSafeEqual(gotBuf, expectedBuf)) {
    throw new WhatsAppSignatureError("signature mismatch");
  }
}
