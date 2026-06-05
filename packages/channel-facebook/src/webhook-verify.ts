/**
 * Webhook verification handshake. Meta при setup'е делает GET с query:
 *   ?hub.mode=subscribe&hub.verify_token=<VERIFY_TOKEN>&hub.challenge=<RANDOM>
 *
 * Если token совпадает — возвращаем challenge как plaintext. Иначе 4xx.
 *
 * apps/api использует этот helper на route GET /webhook/facebook/:slug.
 * (Идентично WhatsApp — Meta использует один и тот же hub-handshake.)
 */
export interface VerifyResult {
  ok: boolean;
  /** Текст для отдачи в body (challenge или error message). */
  body: string;
  /** HTTP status. */
  status: number;
}

export function verifyWebhookSubscription(opts: {
  mode: string | null;
  token: string | null;
  challenge: string | null;
  expectedVerifyToken: string;
}): VerifyResult {
  if (opts.mode !== "subscribe") {
    return { ok: false, body: "hub.mode must be 'subscribe'", status: 400 };
  }
  if (opts.token !== opts.expectedVerifyToken) {
    return { ok: false, body: "verify token mismatch", status: 403 };
  }
  if (!opts.challenge) {
    return { ok: false, body: "hub.challenge missing", status: 400 };
  }
  return { ok: true, body: opts.challenge, status: 200 };
}
