import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { admins } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createMiddleware } from "hono/factory";
import { AuthTokenError, verifyAuthToken } from "../lib/auth.ts";

/**
 * Auth middleware для admin-API routes. Извлекает Bearer token из
 * `Authorization` header (либо `lead_engine_session` cookie если будет
 * добавлено в future), верифицирует HMAC + checks admin still exists,
 * выставляет c.var.{adminId, tenantId, role, email}.
 *
 * 401 если token missing/invalid/expired/admin удалён.
 *
 * Использование:
 *   app.use("/api/admin/*", makeRequireAuth({ db, secret: cfg.authSecret }));
 *   app.get("/api/admin/kb/documents", (c) => {
 *     const tenantId = c.var.tenantId; // string-safe — middleware throws иначе
 *     ...
 *   });
 */
export interface RequireAuthOpts {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  db: PostgresJsDatabase<any>;
  secret: string;
}

declare module "hono" {
  interface ContextVariableMap {
    adminId: number;
    tenantId: number;
    role: "superadmin" | "manager";
    adminEmail: string;
  }
}

export function makeRequireAuth(opts: RequireAuthOpts) {
  return createMiddleware(async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      return c.json({ error: "missing Authorization Bearer token" }, 401);
    }
    let claims: ReturnType<typeof verifyAuthToken>;
    try {
      claims = verifyAuthToken(token, opts.secret);
    } catch (err) {
      if (err instanceof AuthTokenError) {
        return c.json({ error: `auth: ${err.reason}` }, 401);
      }
      return c.json({ error: "auth failed" }, 401);
    }
    // Double-check admin still exists (handles admin-deletion / tenant-revocation
    // scenario без token-blacklist — extra DB-roundtrip но per-request
    // freshness важна для admin-API).
    const [adminRow] = await withTenant(opts.db as unknown as Db, claims.tenantId, (tx) =>
      tx
        .select()
        .from(admins)
        .where(and(eq(admins.id, claims.adminId), eq(admins.tenantId, claims.tenantId))),
    );
    if (!adminRow) {
      return c.json({ error: "admin not found" }, 401);
    }
    c.set("adminId", claims.adminId);
    c.set("tenantId", claims.tenantId);
    c.set("role", claims.role);
    c.set("adminEmail", adminRow.email);
    await next();
  });
}
