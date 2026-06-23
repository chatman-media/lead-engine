import { describe, expect, it } from "bun:test";
import {
  AuthTokenError,
  type AuthClaims,
  DEFAULT_TOKEN_LIFETIME_SEC,
  deriveTenantSlug,
  hashPassword,
  signAuthToken,
  verifyAuthToken,
  verifyPassword,
} from "./auth.ts";

const SECRET = "test-secret-supercalifragilistic";

function makeClaims(overrides: Partial<AuthClaims> = {}): AuthClaims {
  return {
    adminId: 1,
    tenantId: 2,
    role: "superadmin",
    exp: Math.floor(Date.now() / 1000) + DEFAULT_TOKEN_LIFETIME_SEC,
    ...overrides,
  };
}

describe("signAuthToken / verifyAuthToken", () => {
  it("round-trip: sign → verify возвращает те же claims", () => {
    const claims = makeClaims();
    const token = signAuthToken(claims, SECRET);
    expect(token).toContain(".");
    const parsed = verifyAuthToken(token, SECRET);
    expect(parsed).toEqual(claims);
  });

  it("tampered payload → signature mismatch", () => {
    const claims = makeClaims();
    const token = signAuthToken(claims, SECRET);
    const tampered = token.replace(/^./, (c) => (c === "a" ? "b" : "a"));
    expect(() => verifyAuthToken(tampered, SECRET)).toThrow(/signature mismatch/);
  });

  it("wrong secret → signature mismatch", () => {
    const token = signAuthToken(makeClaims(), SECRET);
    expect(() => verifyAuthToken(token, "other-secret")).toThrow(/signature mismatch/);
  });

  it("expired token → throws", () => {
    const expired = signAuthToken(makeClaims({ exp: Math.floor(Date.now() / 1000) - 60 }), SECRET);
    expect(() => verifyAuthToken(expired, SECRET)).toThrow(/expired/);
  });

  it("malformed token (no dot) → throws", () => {
    expect(() => verifyAuthToken("nodothere", SECRET)).toThrow(/malformed token/);
  });

  it("empty secret on sign → throws", () => {
    expect(() => signAuthToken(makeClaims(), "")).toThrow(/secret is empty/);
  });

  it("invalid role → throws", () => {
    const claims = makeClaims();
    // biome-ignore lint/suspicious/noExplicitAny: explicit invalid role
    (claims as any).role = "owner";
    const token = signAuthToken(claims, SECRET);
    expect(() => verifyAuthToken(token, SECRET)).toThrow(/invalid role/);
  });

  it("manager role работает (не только superadmin)", () => {
    const claims = makeClaims({ role: "manager" });
    const token = signAuthToken(claims, SECRET);
    const parsed = verifyAuthToken(token, SECRET);
    expect(parsed.role).toBe("manager");
  });

  it("error type — AuthTokenError instance с reason field", () => {
    try {
      verifyAuthToken("bad.token", SECRET);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthTokenError);
      expect((err as AuthTokenError).reason).toBeTruthy();
    }
  });
});

describe("hashPassword / verifyPassword", () => {
  it("hash + verify happy path", async () => {
    const pwd = "correct-horse-battery-staple";
    const hash = await hashPassword(pwd);
    expect(hash).toContain("argon2");
    expect(await verifyPassword(pwd, hash)).toBe(true);
  });

  it("wrong password → false", async () => {
    const hash = await hashPassword("right-pwd-12345");
    expect(await verifyPassword("wrong-pwd-12345", hash)).toBe(false);
  });

  it("hashes одного password'а различаются (random salt)", async () => {
    const pwd = "deterministic-input-12345";
    const a = await hashPassword(pwd);
    const b = await hashPassword(pwd);
    expect(a).not.toBe(b);
    // оба valid
    expect(await verifyPassword(pwd, a)).toBe(true);
    expect(await verifyPassword(pwd, b)).toBe(true);
  });

  it("password короче 8 → throws", async () => {
    await expect(hashPassword("short1")).rejects.toThrow(/at least 8 characters/);
  });

  it("verifyPassword с garbage hash → false (без throw)", async () => {
    expect(await verifyPassword("any", "not-a-real-hash")).toBe(false);
    expect(await verifyPassword("any", "")).toBe(false);
  });
});

describe("deriveTenantSlug", () => {
  it("ASCII local-part → cleaned + suffix", () => {
    const slug = deriveTenantSlug("alice@example.com");
    expect(slug).toMatch(/^alice-[a-f0-9]{6}$/);
  });

  it("Дешёвая чистка спецсимволов", () => {
    const slug = deriveTenantSlug("Alice.Bob+test@x.com");
    expect(slug).toMatch(/^alicebobtest-[a-f0-9]{6}$/);
  });

  it("non-ASCII local-part → fallback 'tenant-<rand>'", () => {
    const slug = deriveTenantSlug("Тест@x.ru");
    expect(slug).toMatch(/^tenant-[a-f0-9]{6}$/);
  });

  it("длинный local-part обрезается до 24 chars + 6-char suffix", () => {
    const longLocal = "a".repeat(50);
    const slug = deriveTenantSlug(`${longLocal}@x.com`);
    // 24-char local + "-" + 6-char hex
    expect(slug.length).toBe(31);
  });

  it("два call'а с тем же email дают РАЗНЫЕ slug'и (random suffix)", () => {
    const a = deriveTenantSlug("user@x.com");
    const b = deriveTenantSlug("user@x.com");
    expect(a).not.toBe(b);
  });
});
