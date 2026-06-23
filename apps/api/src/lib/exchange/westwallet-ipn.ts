import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * WestWallet IPN authentication.
 *
 * The IPN webhook (`POST /webhook/westwallet/:tenantId`) is otherwise
 * unauthenticated — anyone could POST a forged callback. We bind it to a
 * per-tenant secret token derived from the platform master key, embed that
 * token in the IPN URL we register with WestWallet at invoice creation, and
 * require it on every callback. Only WestWallet (which received the URL) and
 * the platform can compute it, so forged IPNs are rejected before any DB or
 * provider work runs.
 *
 * Deterministic (HMAC of tenantId) so it needs no extra storage and matches on
 * both the create-invoice and webhook sides.
 */

/** Per-tenant IPN verification token (hex, 32 chars). */
export function westWalletIpnToken(tenantId: number, masterKeyHex: string): string {
  return createHmac("sha256", masterKeyHex)
    .update(`westwallet-ipn:${tenantId}`)
    .digest("hex")
    .slice(0, 32);
}

/** Append the IPN token to an IPN URL as `?key=<token>`. Returns input on parse failure. */
export function withIpnKey(ipnUrl: string, tenantId: number, masterKeyHex: string): string {
  try {
    const u = new URL(ipnUrl);
    u.searchParams.set("key", westWalletIpnToken(tenantId, masterKeyHex));
    return u.toString();
  } catch {
    return ipnUrl;
  }
}

/** Constant-time check that `provided` matches the tenant's IPN token. */
export function verifyIpnKey(
  provided: string | undefined | null,
  tenantId: number,
  masterKeyHex: string,
): boolean {
  if (!provided || !masterKeyHex) return false;
  const expected = westWalletIpnToken(tenantId, masterKeyHex);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
