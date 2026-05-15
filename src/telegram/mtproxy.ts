// Parser for MTProto proxy strings, mapped to the shape gramjs expects in
// `new TelegramClient(session, apiId, apiHash, { proxy: ... })`.
//
// Community proxy lists publish entries in a few flavors and we accept all
// three so an operator can paste anything that looks like a proxy without
// reformatting:
//
//   host:port:secret                                — colon-delimited triple
//   tg://proxy?server=H&port=P&secret=S             — Telegram deep link
//   https://t.me/proxy?server=H&port=P&secret=S     — t.me share link
//
// `secret` is a hex string. Modern obfuscated proxies prefix with `dd` (faketls)
// or `ee` (random padding) — we don't validate the leading byte, gramjs handles
// both encodings under the same `MTProxy: true` flag.

/**
 * gramjs's `MTProxyType` shape (kept inline to avoid pulling in a runtime
 * dep on `telegram` from a parser module).
 */
export interface ParsedMTProxy {
  ip: string;
  port: number;
  secret: string;
  MTProxy: true;
  timeout?: number;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

function isValidSecret(s: string): boolean {
  // Real MTProto secrets are 32 hex chars (16 bytes raw) or 34 hex chars
  // (with the `dd`/`ee` flag byte). Allow a slightly wider range so a
  // not-quite-spec-compliant proxy still parses.
  return HEX_RE.test(s) && s.length >= 30 && s.length <= 68;
}

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

function isValidHost(s: string): boolean {
  // Accept either a dotted IPv4 OR a hostname (community lists serve both).
  // Avoid bringing in a full validator — we just want to reject obvious
  // garbage; the connect attempt is the real validator.
  if (s.length === 0 || s.length > 253) return false;
  return /^[a-zA-Z0-9.-]+$/.test(s);
}

/**
 * Parse one of the three supported flavors into a gramjs-ready proxy object.
 * Returns null on anything malformed — caller decides what to do (refuse to
 * start, log + skip, etc.).
 */
export function parseMTProxy(raw: string): ParsedMTProxy | null {
  const input = raw.trim();
  if (!input) return null;

  // URL form (tg:// or https://t.me/...).
  if (input.startsWith("tg://") || input.startsWith("https://")) {
    let parsed: URL;
    try {
      // `tg://` isn't recognized as a special scheme by URL but it parses fine.
      parsed = new URL(input);
    } catch {
      return null;
    }
    const isTgLink =
      input.startsWith("tg://proxy") ||
      (parsed.hostname === "t.me" && parsed.pathname.startsWith("/proxy"));
    if (!isTgLink) return null;

    const server = parsed.searchParams.get("server");
    const portStr = parsed.searchParams.get("port");
    const secret = parsed.searchParams.get("secret");
    if (!server || !portStr || !secret) return null;

    const port = Number(portStr);
    if (!isValidHost(server) || !isValidPort(port) || !isValidSecret(secret)) return null;
    return { ip: server, port, secret, MTProxy: true };
  }

  // Colon-delimited (`host:port:secret`).
  const parts = input.split(":");
  if (parts.length !== 3) return null;
  const [host, portStr, secret] = parts as [string, string, string];
  const port = Number(portStr);
  if (!isValidHost(host) || !isValidPort(port) || !isValidSecret(secret)) return null;
  return { ip: host, port, secret, MTProxy: true };
}
