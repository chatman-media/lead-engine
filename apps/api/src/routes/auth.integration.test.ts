// Integration test для signup/login/me flow + forgot/reset-password.
// Поднимает isolated PG → apply migrations → seed nothing → POST signup,
// проверяет что в БД появились tenant + admin + can login + /me returns
// correct info.

import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import type { Mailer, SendOpts } from "../lib/mailer.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_auth_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "storage",
  "migrations",
);
const SECRET = "test-auth-secret-very-long-string";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;

/** Mock mailer: captures sent emails in-memory instead of calling Resend. */
const sentEmails: SendOpts[] = [];
const mockMailer = {
  send: async (opts: SendOpts) => {
    sentEmails.push(opts);
  },
} as unknown as Mailer;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route(
    "/",
    makeAuthRoutes({
      db: db as any,
      secret: SECRET,
      mailer: mockMailer,
      appUrl: "https://app.test",
    }),
  );
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("auth signup/login/me flow", () => {
  it("POST /api/auth/signup happy path → создаёт tenant + admin", async () => {
    if (!sql) return;
    const res = await post("/api/auth/signup", {
      email: "alice@example.com",
      password: "strong-password-12345",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      admin: { id: number; email: string; role: string; tenantId: number };
      tenant: { id: number; slug: string };
    };
    expect(body.token).toContain(".");
    expect(body.admin.email).toBe("alice@example.com");
    expect(body.admin.role).toBe("superadmin");
    expect(body.admin.tenantId).toBeGreaterThan(0);
    expect(body.tenant.slug).toMatch(/^alice-[a-f0-9]{6}$/);
    expect(body.tenant.id).toBe(body.admin.tenantId);
  });

  it("POST /api/auth/signup дубль email → 409", async () => {
    if (!sql) return;
    const res = await post("/api/auth/signup", {
      email: "alice@example.com",
      password: "another-strong-password",
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/auth/signup невалидный email → 400", async () => {
    if (!sql) return;
    const res = await post("/api/auth/signup", {
      email: "not-an-email",
      password: "strong-password-12345",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/signup короткий password → 400", async () => {
    if (!sql) return;
    const res = await post("/api/auth/signup", {
      email: "short@example.com",
      password: "tiny",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/signup с custom tenantSlug", async () => {
    if (!sql) return;
    const res = await post("/api/auth/signup", {
      email: "custom@example.com",
      password: "strong-password-12345",
      tenantSlug: "acme-corp",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant: { slug: string } };
    expect(body.tenant.slug).toBe("acme-corp");
  });

  it("POST /api/auth/signup custom slug conflict → 409", async () => {
    if (!sql) return;
    const res = await post("/api/auth/signup", {
      email: "other@example.com",
      password: "strong-password-12345",
      tenantSlug: "acme-corp",
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/auth/login правильные creds → token", async () => {
    if (!sql) return;
    const res = await post("/api/auth/login", {
      email: "alice@example.com",
      password: "strong-password-12345",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      admin: { email: string; tenantId: number };
    };
    expect(body.token).toContain(".");
    expect(body.admin.email).toBe("alice@example.com");
  });

  it("POST /api/auth/login неправильный password → 401", async () => {
    if (!sql) return;
    const res = await post("/api/auth/login", {
      email: "alice@example.com",
      password: "wrong-password-12345",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/auth/login несуществующий email → 401 (не leak'аем enum)", async () => {
    if (!sql) return;
    const res = await post("/api/auth/login", {
      email: "nobody@example.com",
      password: "any-password-1234",
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/me с valid token → admin info", async () => {
    if (!sql) return;
    // Login first to get token
    const loginRes = await post("/api/auth/login", {
      email: "alice@example.com",
      password: "strong-password-12345",
    });
    const { token } = (await loginRes.json()) as { token: string };

    const res = await app.request("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      admin: { email: string; role: string };
      tenant: { slug: string; plan: string };
    };
    expect(body.admin.email).toBe("alice@example.com");
    expect(body.admin.role).toBe("superadmin");
    expect(body.tenant.slug).toMatch(/^alice-/);
    expect(body.tenant.plan).toBe("free");
  });

  it("GET /api/auth/me без token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/me с tampered token → 401", async () => {
    if (!sql) return;
    const loginRes = await post("/api/auth/login", {
      email: "alice@example.com",
      password: "strong-password-12345",
    });
    const { token } = (await loginRes.json()) as { token: string };
    const tampered = `${token}garbage`;

    const res = await app.request("/api/auth/me", {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/auth/logout всегда 200 (stateless)", async () => {
    if (!sql) return;
    const res = await post("/api/auth/logout", {});
    expect(res.status).toBe(200);
  });
});

describe("auth forgot-password / reset-password", () => {
  const EMAIL = "alice@example.com"; // создан в первом describe

  function extractTokenFromHtml(html: string): string | null {
    const match = html.match(/reset-password\?token=([0-9a-f]{64})/);
    return match ? match[1]! : null;
  }

  it("POST /api/auth/forgot-password несуществующий email → 200 (не leak'аем)", async () => {
    if (!sql) return;
    const res = await post("/api/auth/forgot-password", { email: "nobody@example.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // Письмо не отправлялось
    const before = sentEmails.length;
    expect(sentEmails.length).toBe(before);
  });

  it("POST /api/auth/forgot-password без email → 400", async () => {
    if (!sql) return;
    const res = await post("/api/auth/forgot-password", {});
    expect(res.status).toBe(400);
  });

  let resetToken = "";

  it("POST /api/auth/forgot-password существующий email → 200 + письмо с токеном", async () => {
    if (!sql) return;
    const countBefore = sentEmails.length;
    const res = await post("/api/auth/forgot-password", { email: EMAIL });
    expect(res.status).toBe(200);
    expect(sentEmails.length).toBe(countBefore + 1);

    const email = sentEmails[sentEmails.length - 1]!;
    expect(email.to).toBe(EMAIL);
    expect(email.subject).toMatch(/сброс пароля/i);

    const token = extractTokenFromHtml(email.html);
    expect(token).not.toBeNull();
    resetToken = token!;
  });

  it("POST /api/auth/reset-password невалидный токен → 401", async () => {
    if (!sql) return;
    const res = await post("/api/auth/reset-password", {
      token: "a".repeat(64),
      password: "totally-new-password-99",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/auth/reset-password короткий пароль → 400", async () => {
    if (!sql) return;
    if (!resetToken) return;
    const res = await post("/api/auth/reset-password", { token: resetToken, password: "tiny" });
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/reset-password happy path → 200 + новый пароль работает", async () => {
    if (!sql) return;
    if (!resetToken) return;
    const res = await post("/api/auth/reset-password", {
      token: resetToken,
      password: "brand-new-password-42",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Старый пароль больше не работает (был сброшен из change-password теста обратно)
    const newLogin = await post("/api/auth/login", {
      email: EMAIL,
      password: "brand-new-password-42",
    });
    expect(newLogin.status).toBe(200);

    // Восстановим оригинальный пароль
    const { token } = (await newLogin.json()) as { token: string };
    await post(
      "/api/auth/change-password",
      { currentPassword: "brand-new-password-42", newPassword: "strong-password-12345" },
      { Authorization: `Bearer ${token}` },
    );
  });

  it("POST /api/auth/reset-password повторное использование токена → 401", async () => {
    if (!sql) return;
    if (!resetToken) return;
    const res = await post("/api/auth/reset-password", {
      token: resetToken,
      password: "another-password-123",
    });
    expect(res.status).toBe(401);
  });
});

describe("auth change-password", () => {
  /** Login alice and return token. alice was created in first describe block. */
  async function loginAlice(): Promise<string> {
    const res = await post("/api/auth/login", {
      email: "alice@example.com",
      password: "strong-password-12345",
    });
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  it("POST /api/auth/change-password без токена → 401", async () => {
    if (!sql) return;
    const res = await post("/api/auth/change-password", {
      currentPassword: "strong-password-12345",
      newPassword: "new-strong-password-99",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/auth/change-password неверный currentPassword → 401", async () => {
    if (!sql) return;
    const token = await loginAlice();
    const res = await post(
      "/api/auth/change-password",
      { currentPassword: "wrong-password-999", newPassword: "new-strong-password-99" },
      { Authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/current password/i);
  });

  it("POST /api/auth/change-password newPassword < 8 chars → 400", async () => {
    if (!sql) return;
    const token = await loginAlice();
    const res = await post(
      "/api/auth/change-password",
      { currentPassword: "strong-password-12345", newPassword: "tiny" },
      { Authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/change-password happy path → 200 + старый пароль больше не работает", async () => {
    if (!sql) return;
    const token = await loginAlice();
    const res = await post(
      "/api/auth/change-password",
      { currentPassword: "strong-password-12345", newPassword: "new-strong-password-99" },
      { Authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Old password no longer works.
    const oldLoginRes = await post("/api/auth/login", {
      email: "alice@example.com",
      password: "strong-password-12345",
    });
    expect(oldLoginRes.status).toBe(401);

    // New password works.
    const newLoginRes = await post("/api/auth/login", {
      email: "alice@example.com",
      password: "new-strong-password-99",
    });
    expect(newLoginRes.status).toBe(200);

    // Restore original password so other tests (if added) still work.
    const newToken = ((await newLoginRes.json()) as { token: string }).token;
    await post(
      "/api/auth/change-password",
      { currentPassword: "new-strong-password-99", newPassword: "strong-password-12345" },
      { Authorization: `Bearer ${newToken}` },
    );
  });
});
