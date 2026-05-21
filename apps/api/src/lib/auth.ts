import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless auth для apps/api admin-API. JWT-like token:
 *   base64url(JSON{adminId, tenantId, role, exp}).base64url(HMAC-SHA256(...))
 *
 * Не настоящий JWT (без `alg`/`typ` header'а) — нам нужны только sign/verify
 * чтобы admin-UI имел session-handle. HMAC-key — `PLATFORM_AUTH_SECRET` env
 * (fallback на `PLATFORM_MASTER_KEY` если первого нет — для backwards-compat
 * с существующими dev-deploy'ями).
 *
 * Password hashing — `Bun.password.hash` (argon2id by default, secure).
 * Verify — `Bun.password.verify`.
 */

export interface AuthClaims {
  adminId: number;
  tenantId: number;
  /** 'superadmin' (полный доступ) или 'manager' (повседневное) — copy из admins.role. */
  role: "superadmin" | "manager";
  /** Unix epoch — токен невалиден после этого момента. */
  exp: number;
}

export class AuthTokenError extends Error {
  constructor(public reason: string) {
    super(`auth token: ${reason}`);
    this.name = "AuthTokenError";
  }
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/**
 * Подписывает claims и возвращает token-строку. Caller сам выставляет exp.
 * Default lifetime = 30 дней (admin sessions long-lived; logout = drop cookie).
 */
export function signAuthToken(claims: AuthClaims, secret: string): string {
  if (!secret) throw new AuthTokenError("secret is empty");
  const payload = b64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = b64urlEncode(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * Верифицирует token + parsing claims. Throws AuthTokenError на любую проблему
 * (malformed, bad sig, expired).
 */
export function verifyAuthToken(token: string, secret: string): AuthClaims {
  if (!secret) throw new AuthTokenError("secret is empty");
  if (typeof token !== "string" || !token.includes(".")) {
    throw new AuthTokenError("malformed token");
  }
  const dot = token.indexOf(".");
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = b64urlEncode(createHmac("sha256", secret).update(payload).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new AuthTokenError("signature mismatch");
  }
  let claims: AuthClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString("utf8")) as AuthClaims;
  } catch {
    throw new AuthTokenError("payload not JSON");
  }
  if (
    typeof claims.adminId !== "number" ||
    typeof claims.tenantId !== "number" ||
    typeof claims.exp !== "number"
  ) {
    throw new AuthTokenError("payload missing required fields");
  }
  if (claims.role !== "superadmin" && claims.role !== "manager") {
    throw new AuthTokenError("invalid role");
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) throw new AuthTokenError("expired");
  return claims;
}

/**
 * Hashes a password с argon2id (Bun built-in). Use на signup.
 * Returns строку формата `$argon2id$v=...$<salt>$<hash>` — full info стор'ить
 * в admins.password_hash.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Verifies password против stored hash. Returns boolean (no throws). */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!password || !hash) return false;
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

/**
 * Derives a unique tenant slug from email local-part + random suffix.
 * Slug = lowercase ASCII letters/numbers/dashes, до 32 chars.
 * Caller проверяет uniqueness в БД (slug column unique constraint защищает
 * от race), на conflict — пересоздать с новым suffix.
 *
 * Examples:
 *   "alice@example.com"  → "alice-a1b2c3"
 *   "Тест@x.ru"         → "tenant-<rand>" (нет ASCII local-part)
 */
export function deriveTenantSlug(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const base = cleaned.length >= 2 ? cleaned : "tenant";
  const suffix = randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

/** Default token lifetime: 30 days. */
export const DEFAULT_TOKEN_LIFETIME_SEC = 30 * 24 * 60 * 60;
