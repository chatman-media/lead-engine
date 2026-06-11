/**
 * SSRF-guarded fetch for outbound requests whose destination is controlled by
 * a tenant (webhook URLs, partner callbacks, service-catalog hooks). A tenant
 * admin is a *customer*, not the platform operator — so a tenant-supplied URL
 * pointing at `http://169.254.169.254/...` or an internal service crosses a
 * trust boundary.
 *
 * `safeFetch` resolves the target hostname and refuses to connect to private,
 * loopback, link-local, unique-local, multicast or otherwise non-public
 * addresses (IPv4 + IPv6), and re-validates every redirect hop.
 *
 * Residual limitation: this is not a full DNS-rebinding defence — between our
 * lookup and the socket connect the name could re-resolve. Pinning the resolved
 * IP at connect time would need a custom dispatcher; the lookup-based check
 * already blocks the overwhelming majority of SSRF payloads. Documented so the
 * gap is explicit rather than silent.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** Parse a dotted-quad IPv4 string into a 32-bit unsigned int, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

function inCidr(ipInt: number, base: string, maskBits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** True if an IPv4 address is not a globally-routable public address. */
function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  return (
    inCidr(n, "0.0.0.0", 8) || // "this" network / unspecified
    inCidr(n, "10.0.0.0", 8) || // private
    inCidr(n, "100.64.0.0", 10) || // CGNAT
    inCidr(n, "127.0.0.0", 8) || // loopback
    inCidr(n, "169.254.0.0", 16) || // link-local (cloud metadata 169.254.169.254)
    inCidr(n, "172.16.0.0", 12) || // private
    inCidr(n, "192.0.0.0", 24) || // IETF protocol assignments
    inCidr(n, "192.0.2.0", 24) || // TEST-NET-1
    inCidr(n, "192.168.0.0", 16) || // private
    inCidr(n, "198.18.0.0", 15) || // benchmarking
    inCidr(n, "198.51.100.0", 24) || // TEST-NET-2
    inCidr(n, "203.0.113.0", 24) || // TEST-NET-3
    inCidr(n, "224.0.0.0", 4) || // multicast
    inCidr(n, "240.0.0.0", 4) // reserved / broadcast
  );
}

/** True if an IPv6 address is not a globally-routable public address. */
function isBlockedIPv6(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "");

  // IPv4-mapped / -compatible (::ffff:a.b.c.d, ::a.b.c.d) → check embedded v4.
  const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);

  if (ip === "::" || ip === "::1") return true; // unspecified / loopback
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb"))
    return true; // link-local fe80::/10
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique-local fc00::/7
  if (ip.startsWith("ff")) return true; // multicast ff00::/8
  if (ip.startsWith("::ffff:")) return true; // IPv4-mapped without dotted form
  if (ip.startsWith("64:ff9b:")) return true; // NAT64 well-known prefix
  return false;
}

/** True if a literal IP string is in a blocked (non-public) range. */
export function isBlockedIpLiteral(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) return isBlockedIPv4(host);
  if (kind === 6) return isBlockedIPv6(host);
  return false; // not an IP literal
}

/**
 * Validates that `urlStr` is an http(s) URL whose host resolves only to public
 * addresses. Throws `SsrfError` otherwise. Exposed for early (create-time)
 * rejection in addition to the runtime `safeFetch` check.
 */
export async function assertPublicUrl(urlStr: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new SsrfError("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfError(`blocked protocol: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");

  // Literal IP host → check directly, no DNS.
  const literalKind = isIP(host);
  if (literalKind !== 0) {
    if (isBlockedIpLiteral(host)) throw new SsrfError(`blocked address: ${host}`);
    return;
  }

  // Obvious local names — block before paying for DNS.
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new SsrfError(`blocked host: ${host}`);
  }

  // Resolve the name and reject if ANY returned address is non-public.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfError(`dns resolution failed: ${host}`);
  }
  if (addrs.length === 0) throw new SsrfError(`no address for host: ${host}`);
  for (const a of addrs) {
    const blocked = a.family === 6 ? isBlockedIPv6(a.address) : isBlockedIPv4(a.address);
    if (blocked) throw new SsrfError(`host resolves to blocked address: ${a.address}`);
  }
}

export interface SafeFetchOptions {
  /** Max redirect hops to follow (each re-validated). Default 3. */
  maxRedirects?: number;
}

/**
 * Drop-in `fetch` replacement that blocks SSRF. Validates the target before
 * each request and follows redirects manually so a 3xx to an internal address
 * cannot bypass the guard. Same signature as global fetch for easy swap-in.
 */
export async function safeFetch(
  input: string | URL,
  init?: RequestInit,
  opts?: SafeFetchOptions,
): Promise<Response> {
  const maxRedirects = opts?.maxRedirects ?? 3;
  let url = typeof input === "string" ? input : input.toString();

  for (let hop = 0; ; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { ...init, redirect: "manual" });
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) return res;
    if (hop >= maxRedirects) throw new SsrfError("too many redirects");
    const location = res.headers.get("location") ?? "";
    url = new URL(location, url).toString();
  }
}
