import { config } from "../config.ts";
import type { Sql } from "../db/postgres.ts";
import { type AdminRole, AdminsRepo } from "../db/repos/admins.ts";
import { SessionsRepo } from "../db/repos/sessions.ts";
import { json, type RouteHandler } from "../router.ts";

const COOKIE_PATH = "/";

export interface AuthContext {
  adminId: number;
  email: string;
  role: AdminRole;
}

export function readSessionCookie(req: Request): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === config.admin.sessionCookie) return v ?? "";
  }
  return null;
}

function buildCookie(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${config.admin.sessionCookie}=${value}`,
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.publicBaseUrl.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

/** Look up the current admin from the request's session cookie, if any. */
export async function currentAdmin(sql: Sql, req: Request): Promise<AuthContext | null> {
  const sid = readSessionCookie(req);
  if (!sid) return null;
  const sessions = new SessionsRepo(sql);
  const adminId = await sessions.adminIdFor(sid);
  if (adminId === null) return null;
  const admin = await new AdminsRepo(sql).byId(adminId);
  if (!admin) return null;
  return { adminId: admin.id, email: admin.email, role: admin.role };
}

export async function requireAdmin(sql: Sql, req: Request): Promise<AuthContext | Response> {
  const ctx = await currentAdmin(sql, req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return ctx;
}

/**
 * Like requireAdmin but additionally requires the `superadmin` role.
 * Returns 403 for an authenticated manager — the action is reserved for
 * destructive operations and system settings.
 */
export async function requireSuperadmin(sql: Sql, req: Request): Promise<AuthContext | Response> {
  const ctx = await requireAdmin(sql, req);
  if (ctx instanceof Response) return ctx;
  if (ctx.role !== "superadmin") {
    return json({ error: "forbidden — requires superadmin" }, { status: 403 });
  }
  return ctx;
}

export function createLoginHandler(sql: Sql): RouteHandler {
  const admins = new AdminsRepo(sql);
  const sessions = new SessionsRepo(sql);
  return async ({ req }) => {
    let body: { email?: unknown; password?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return json({ error: "email and password are required" }, { status: 400 });
    }
    const admin = await admins.verifyPassword(email, password);
    if (!admin) return json({ error: "invalid credentials" }, { status: 401 });

    const ttl = config.admin.sessionTtlDays * 24 * 60 * 60;
    const sid = await sessions.issue(admin.id, { ttlSeconds: ttl });
    return json(
      { admin: { id: admin.id, email: admin.email, role: admin.role } },
      { headers: { "set-cookie": buildCookie(sid, ttl) } },
    );
  };
}

export function createLogoutHandler(sql: Sql): RouteHandler {
  const sessions = new SessionsRepo(sql);
  return async ({ req }) => {
    const sid = readSessionCookie(req);
    if (sid) await sessions.revoke(sid);
    return json({ ok: true }, { headers: { "set-cookie": buildCookie("", 0) } });
  };
}

export function createMeHandler(sql: Sql): RouteHandler {
  return async ({ req }) => {
    const ctx = await requireAdmin(sql, req);
    if (ctx instanceof Response) return ctx;
    return json({ admin: { id: ctx.adminId, email: ctx.email, role: ctx.role } });
  };
}

/**
 * POST /admin/api/account/password — the logged-in admin changes their own
 * password. Available to both roles. Requires the current password so a
 * hijacked session can't silently lock the owner out.
 */
export function createChangePasswordHandler(sql: Sql): RouteHandler {
  const admins = new AdminsRepo(sql);
  return async ({ req }) => {
    const ctx = await requireAdmin(sql, req);
    if (ctx instanceof Response) return ctx;

    let body: { current_password?: unknown; new_password?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const current = typeof body.current_password === "string" ? body.current_password : "";
    const next = typeof body.new_password === "string" ? body.new_password : "";
    if (!current || !next) {
      return json({ error: "current_password and new_password are required" }, { status: 400 });
    }
    if (next.length < 8) {
      return json({ error: "new password must be at least 8 characters" }, { status: 400 });
    }

    const verified = await admins.verifyPassword(ctx.email, current);
    if (!verified) {
      return json({ error: "current password is incorrect" }, { status: 401 });
    }

    try {
      await admins.updatePassword(ctx.adminId, next);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
    return json({ ok: true });
  };
}
