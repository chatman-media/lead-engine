import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Per-visitor identity binding for the public web-chat WebSocket.
 *
 * The web widget runs on untrusted third-party pages, so the `externalUserId`
 * a client sends cannot be trusted on its own — without binding, anyone could
 * connect as `?user=<victim>` and read/write that visitor's conversation.
 *
 * Instead the server ASSIGNS a random `externalUserId` on first connect and
 * returns an HMAC token over `(tenantSlug, userId)`. On reconnect the client
 * replays `?user=<id>&token=<token>`; the server recomputes the HMAC and
 * rejects any mismatch. An attacker cannot forge a token for someone else's id
 * (no secret) and cannot guess the 128-bit random id, so impersonation is
 * closed while anonymous sessions still work (each visitor mints its own).
 *
 * Secret = `cfg.authSecret` (PLATFORM_AUTH_SECRET / PLATFORM_MASTER_KEY), the
 * same strong key used for admin tokens — so binding is always enforced, with
 * no "auth disabled" dev mode.
 */

/** Generate a fresh, unguessable web visitor id. */
export function newWebUserId(): string {
  return `web-${randomBytes(16).toString("hex")}`;
}

/** HMAC-SHA256(secret, `${slug}\n${userId}`) as lowercase hex. */
export function signWebSession(slug: string, userId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${slug}\n${userId}`).digest("hex");
}

/** Constant-time verify of a web-session token. Returns false on any mismatch. */
export function verifyWebSession(
  slug: string,
  userId: string,
  token: string,
  secret: string,
): boolean {
  if (!token || !secret) return false;
  const expected = signWebSession(slug, userId, secret);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
