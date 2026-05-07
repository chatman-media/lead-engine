import type { Database } from "bun:sqlite";

import { config } from "../config.ts";
import { AdminsRepo } from "../db/repos/admins.ts";
import { SessionsRepo } from "../db/repos/sessions.ts";
import { json, type RouteHandler } from "../router.ts";

const COOKIE_PATH = "/";

export interface AuthContext {
  adminId: number;
  email: string;
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
export function currentAdmin(db: Database, req: Request): AuthContext | null {
  const sid = readSessionCookie(req);
  if (!sid) return null;
  const sessions = new SessionsRepo(db);
  const adminId = sessions.adminIdFor(sid);
  if (adminId === null) return null;
  const admin = new AdminsRepo(db).byId(adminId);
  if (!admin) return null;
  return { adminId: admin.id, email: admin.email };
}

export function requireAdmin(db: Database, req: Request): AuthContext | Response {
  const ctx = currentAdmin(db, req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return ctx;
}

export function createLoginHandler(db: Database): RouteHandler {
  const admins = new AdminsRepo(db);
  const sessions = new SessionsRepo(db);
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
    const sid = sessions.issue(admin.id, { ttlSeconds: ttl });
    return json(
      { admin: { id: admin.id, email: admin.email } },
      { headers: { "set-cookie": buildCookie(sid, ttl) } },
    );
  };
}

export function createLogoutHandler(db: Database): RouteHandler {
  const sessions = new SessionsRepo(db);
  return ({ req }) => {
    const sid = readSessionCookie(req);
    if (sid) sessions.revoke(sid);
    return json({ ok: true }, { headers: { "set-cookie": buildCookie("", 0) } });
  };
}

export function createMeHandler(db: Database): RouteHandler {
  return ({ req }) => {
    const ctx = requireAdmin(db, req);
    if (ctx instanceof Response) return ctx;
    return json({ admin: { id: ctx.adminId, email: ctx.email } });
  };
}
