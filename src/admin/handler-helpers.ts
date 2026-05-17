// Combinators that collapse the boilerplate every admin route handler
// used to repeat — requireAdmin guard + id parsing + JSON body parsing.
//
// Each helper returns either the parsed value OR a Response, so the
// caller does `if (x instanceof Response) return x;` and proceeds with
// a narrowed type. The `withAdmin` wrapper is the entry point and pre-
// runs the auth check so every wrapped handler always sees a valid
// `ctx.admin: AuthContext`.

import type { Sql } from "../db/postgres.ts";
import { json, type RouteContext, type RouteHandler } from "../router.ts";
import { type AuthContext, requireAdmin, requireSuperadmin } from "./auth.ts";

/** Same shape as RouteHandler but with `admin` (the authenticated
 *  AuthContext) injected. */
export type AdminHandler = (
  ctx: RouteContext & { admin: AuthContext },
) => Response | Promise<Response>;

/**
 * Wrap an admin handler so the requireAdmin guard runs once at the top
 * of every request and the resulting AuthContext is threaded into the
 * handler. Saves the two-line `const ctx = await requireAdmin(...);
 * if (ctx instanceof Response) return ctx;` boilerplate that previously
 * led every handler.
 */
export function withAdmin(sql: Sql, handler: AdminHandler): RouteHandler {
  return async (ctx) => {
    const admin = await requireAdmin(sql, ctx.req);
    if (admin instanceof Response) return admin;
    return handler({ ...ctx, admin });
  };
}

/**
 * Same as `withAdmin` but rejects authenticated managers with 403. Wrap
 * destructive operations and system-settings endpoints with this so only
 * superadmins can run them.
 */
export function withSuperadmin(sql: Sql, handler: AdminHandler): RouteHandler {
  return async (ctx) => {
    const admin = await requireSuperadmin(sql, ctx.req);
    if (admin instanceof Response) return admin;
    return handler({ ...ctx, admin });
  };
}

/**
 * Validate a `:id`-style route param. Returns the parsed positive
 * integer OR a 400 Response. Callers do:
 *   const id = parseIdParam(params);
 *   if (id instanceof Response) return id;
 */
export function parseIdParam(params: Record<string, string>, name = "id"): number | Response {
  const raw = params[name];
  if (!raw) return json({ error: `${name} is required` }, { status: 400 });
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return json({ error: `bad ${name}` }, { status: 400 });
  }
  return n;
}

/**
 * Parse the request body as JSON. Returns the parsed value (typed as the
 * generic T — caller is responsible for narrow validation afterwards)
 * OR a 400 Response on malformed JSON.
 */
export async function parseJsonBody<T = unknown>(req: Request): Promise<T | Response> {
  try {
    return (await req.json()) as T;
  } catch {
    return json({ error: "invalid JSON" }, { status: 400 });
  }
}
