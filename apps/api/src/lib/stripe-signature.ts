// Stripe webhook signature verification. Не нужен stripe-node SDK —
// HMAC-SHA256 от "<timestamp>.<raw_body>" с webhook secret.
//
// Header формат:
//   Stripe-Signature: t=<unix_ts>,v1=<hex>,v1=<hex>,...
//
// Может быть несколько v1 — это во время rolling rotation. Проходит
// если хоть один matches.
//
// Документация: https://stripe.com/docs/webhooks/signatures

import { createHmac, timingSafeEqual } from "node:crypto";

export class StripeSignatureError extends Error {
  constructor(public readonly reason: string) {
    super(`stripe signature invalid: ${reason}`);
    this.name = "StripeSignatureError";
  }
}

/**
 * Парсит Stripe-Signature header. Возвращает { timestamp, signatures } или
 * throws StripeSignatureError на malformed input.
 */
export function parseSignatureHeader(header: string | null | undefined): {
  timestamp: number;
  signatures: string[];
} {
  if (!header) throw new StripeSignatureError("header missing");
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    if (k === "t") {
      const t = Number.parseInt(v, 10);
      if (Number.isFinite(t)) timestamp = t;
    } else if (k === "v1") {
      signatures.push(v);
    }
  }
  if (timestamp === undefined) throw new StripeSignatureError("no t= timestamp");
  if (signatures.length === 0) throw new StripeSignatureError("no v1= signatures");
  return { timestamp, signatures };
}

export interface VerifyOptions {
  /** Stripe webhook signing secret (whsec_...). */
  secret: string;
  /** Raw request body как UTF-8 string. */
  payload: string;
  /** Содержимое Stripe-Signature header'а. */
  header: string | null | undefined;
  /**
   * Max возраст события в секундах. Default 300 (5 минут) — anti-replay
   * protection. Stripe сам ретриит несколько часов, но webhook handler
   * должен быть быстр; старше 5 мин = подозрительно.
   */
  toleranceSec?: number;
  /** Опционально: override now() для тестов. */
  nowEpoch?: number;
}

/**
 * Верифицирует Stripe-Signature. Возвращает void (success) или бросает
 * StripeSignatureError. Constant-time compare защищает от timing attacks.
 */
export function verifyStripeSignature(opts: VerifyOptions): void {
  const { timestamp, signatures } = parseSignatureHeader(opts.header);
  const tolerance = opts.toleranceSec ?? 300;
  const now = opts.nowEpoch ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    throw new StripeSignatureError(
      `timestamp ${timestamp} outside tolerance ${tolerance}s (now=${now})`,
    );
  }
  const signedPayload = `${timestamp}.${opts.payload}`;
  const expectedHex = createHmac("sha256", opts.secret)
    .update(signedPayload, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  for (const sig of signatures) {
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(sig, "hex");
    } catch {
      continue;
    }
    if (sigBuf.length !== expectedBuf.length) continue;
    if (timingSafeEqual(sigBuf, expectedBuf)) return;
  }
  throw new StripeSignatureError("no v1 signature matched");
}
