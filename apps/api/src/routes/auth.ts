import { withTenant } from "@chatman-media/conversation-engine";
import { admins, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import {
  AuthTokenError,
  DEFAULT_TOKEN_LIFETIME_SEC,
  deriveTenantSlug,
  hashPassword,
  signAuthToken,
  verifyPassword,
} from "../lib/auth.ts";

/**
 * Auth-endpoints для SaaS-flow:
 *   POST /api/auth/signup — создаёт tenant + admin, возвращает session token
 *   POST /api/auth/login  — verify email/password, возвращает token
 *   POST /api/auth/logout — клиент сам drops token (stateless), endpoint
 *                           возвращает 200 для symmetry / cookie-clear
 *   GET  /api/auth/me     — возвращает текущего admin'а из Authorization header
 *
 * Token: stateless HMAC-SHA256-signed (см. lib/auth.ts). Подписывается
 * PLATFORM_AUTH_SECRET env (fallback PLATFORM_MASTER_KEY). Lifetime 30 дней.
 *
 * Cookies vs Authorization header:
 *   На SaaS-стороне сервер ставит httpOnly+Secure+SameSite=Lax cookie =
 *   `lead_engine_session=<token>`. Browser sends автоматически.
 *   Для API consumers (admin-ui SPA на ALT-host) → `Authorization: Bearer
 *   <token>` через локальное хранилище.
 *   Endpoint принимает оба — middleware читает оба источника.
 */
export interface AuthRoutesOpts {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  db: PostgresJsDatabase<any>;
  /** Secret для HMAC sign/verify. PLATFORM_AUTH_SECRET или fallback. */
  secret: string;
}

interface SignupBody {
  email: unknown;
  password: unknown;
  /** Опциональный custom slug. Если пусто — derive из email + random suffix. */
  tenantSlug?: unknown;
}

interface LoginBody {
  email: unknown;
  password: unknown;
}

export function makeAuthRoutes(opts: AuthRoutesOpts): Hono {
  const app = new Hono();

  /**
   * POST /api/auth/signup
   * Body: { email, password, tenantSlug? }
   * Returns: { token, admin: { id, email, role, tenantId }, tenant: { id, slug } }
   *
   * Создаёт **новый tenant** (free plan, byok billing) и **первого
   * admin'а** с role='superadmin'. Это primary self-service entry-point —
   * один email = один tenant. Multi-admin per tenant — invite flow
   * (отдельный endpoint, не в этом PR).
   */
  app.post("/api/auth/signup", async (c) => {
    let body: SignupBody;
    try {
      body = (await c.req.json()) as SignupBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const customSlug =
      typeof body.tenantSlug === "string" && body.tenantSlug.length > 0
        ? body.tenantSlug.trim().toLowerCase()
        : undefined;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "invalid email" }, 400);
    }
    if (password.length < 8) {
      return c.json({ error: "password must be at least 8 characters" }, 400);
    }
    if (customSlug && !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(customSlug)) {
      return c.json({ error: "invalid tenantSlug (lowercase, a-z 0-9 -, 3-32 chars)" }, 400);
    }

    // 1. Email uniqueness check (admin.email UNIQUE).
    const existing = await opts.db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.email, email));
    if (existing.length > 0) {
      return c.json({ error: "email already registered" }, 409);
    }

    // 2. Pick slug — custom если задан, иначе derived. Retry на conflict
    // через uniq constraint.
    let slug = customSlug ?? deriveTenantSlug(email);
    let tenantRow: { id: number; slug: string } | null = null;
    let attempt = 0;
    const nowEpoch = Math.floor(Date.now() / 1000);
    while (attempt < 5 && !tenantRow) {
      attempt++;
      try {
        const [t] = await opts.db
          .insert(tenants)
          .values({
            slug,
            plan: "free",
            status: "active",
            llmBillingMode: "byok",
            createdAt: nowEpoch,
            updatedAt: nowEpoch,
          })
          .returning();
        if (t) tenantRow = { id: t.id, slug: t.slug };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("unique") || msg.includes("duplicate")) {
          if (customSlug) {
            // Если пользователь явно задал — вернуть 409 (не reroll'им).
            return c.json({ error: "tenantSlug already taken" }, 409);
          }
          // Derived slug — reroll с новым suffix.
          slug = deriveTenantSlug(email);
          continue;
        }
        throw err;
      }
    }
    if (!tenantRow) {
      return c.json({ error: "could not allocate tenant slug after 5 attempts" }, 500);
    }

    // 3. Hash password + insert admin (linked to new tenant).
    const passwordHash = await hashPassword(password);
    // Admin INSERT под new tenant-context — RLS-correct.
    const [adminRow] = await withTenant(
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
      opts.db as any,
      tenantRow.id,
      async (tx) =>
        tx
          .insert(admins)
          .values({
            tenantId: tenantRow!.id,
            email,
            passwordHash,
            role: "superadmin",
            createdAt: nowEpoch,
          })
          .returning(),
    );
    if (!adminRow) {
      return c.json({ error: "admin insert returned no row" }, 500);
    }

    // 4. Sign session token.
    const token = signAuthToken(
      {
        adminId: adminRow.id,
        tenantId: tenantRow.id,
        role: "superadmin",
        exp: nowEpoch + DEFAULT_TOKEN_LIFETIME_SEC,
      },
      opts.secret,
    );

    return c.json({
      token,
      admin: { id: adminRow.id, email, role: "superadmin", tenantId: tenantRow.id },
      tenant: { id: tenantRow.id, slug: tenantRow.slug },
    });
  });

  /**
   * POST /api/auth/login
   * Body: { email, password }
   * Returns: { token, admin: { id, email, role, tenantId } } | 401
   */
  app.post("/api/auth/login", async (c) => {
    let body: LoginBody;
    try {
      body = (await c.req.json()) as LoginBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return c.json({ error: "email and password required" }, 400);
    }

    const [adminRow] = await opts.db
      .select()
      .from(admins)
      .where(eq(admins.email, email));
    if (!adminRow) {
      // Generic 401 — не выдаём что email не существует (user enum prevention).
      return c.json({ error: "invalid credentials" }, 401);
    }
    const ok = await verifyPassword(password, adminRow.passwordHash);
    if (!ok) {
      return c.json({ error: "invalid credentials" }, 401);
    }

    const role: "superadmin" | "manager" =
      adminRow.role === "manager" ? "manager" : "superadmin";
    const nowEpoch = Math.floor(Date.now() / 1000);
    const token = signAuthToken(
      {
        adminId: adminRow.id,
        tenantId: adminRow.tenantId,
        role,
        exp: nowEpoch + DEFAULT_TOKEN_LIFETIME_SEC,
      },
      opts.secret,
    );

    return c.json({
      token,
      admin: {
        id: adminRow.id,
        email: adminRow.email,
        role,
        tenantId: adminRow.tenantId,
      },
    });
  });

  /**
   * POST /api/auth/logout
   * Stateless server side — client drops token. Endpoint существует только
   * для symmetric API + чтобы clients могли централизованно вызвать flow.
   * Future: добавить server-side token revocation list если потребуется.
   */
  app.post("/api/auth/logout", (c) => {
    return c.json({ ok: true });
  });

  /**
   * GET /api/auth/me
   * Verify token from Authorization header → return admin info.
   * Если token невалидный/missing → 401. Используется admin-UI на boot
   * чтобы понять — залогинен или нет.
   */
  app.get("/api/auth/me", async (c) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return c.json({ error: "missing Authorization Bearer token" }, 401);
    let claims: ReturnType<typeof verifyAuthToken>;
    try {
      claims = (await import("../lib/auth.ts")).verifyAuthToken(token, opts.secret);
    } catch (err) {
      if (err instanceof AuthTokenError) return c.json({ error: err.reason }, 401);
      return c.json({ error: "auth failed" }, 401);
    }
    const [adminRow] = await opts.db
      .select()
      .from(admins)
      .where(and(eq(admins.id, claims.adminId), eq(admins.tenantId, claims.tenantId)));
    if (!adminRow) return c.json({ error: "admin not found" }, 401);
    const [tenantRow] = await opts.db
      .select({ slug: tenants.slug, plan: tenants.plan })
      .from(tenants)
      .where(eq(tenants.id, claims.tenantId));
    return c.json({
      admin: {
        id: adminRow.id,
        email: adminRow.email,
        role: adminRow.role,
        tenantId: adminRow.tenantId,
      },
      tenant: tenantRow ? { id: claims.tenantId, slug: tenantRow.slug, plan: tenantRow.plan } : null,
    });
  });

  return app;
}

// Re-import для типизации в /me (избегаем top-level cycle).
import { verifyAuthToken } from "../lib/auth.ts";
