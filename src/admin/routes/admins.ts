// Operator management — superadmins create / list / delete admin accounts
// and reset their passwords from the UI, so an agency owner can onboard
// managers without shell access to `scripts/create-admin.ts`.
//
// Every handler is superadmin-gated. Two safety rails: a superadmin can
// neither delete their own account nor remove the last remaining
// superadmin (either would lock the agency out of destructive ops).

import { AdminsRepo, isAdminRole } from "../../db/repos/admins.ts";
import { AuditLogRepo } from "../../db/repos/audit-log.ts";
import { json, type RouteHandler } from "../../router.ts";
import { parseIdParam, parseJsonBody, withSuperadmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

const EMAIL_MAX = 200;

/** GET /admin/api/admins → { admins: AdminSummary[] } */
export function createListAdminsHandler(deps: AdminApiDeps): RouteHandler {
  const admins = new AdminsRepo(deps.sql);
  return withSuperadmin(deps.sql, async () => {
    return json({ admins: await admins.list() });
  });
}

/** POST /admin/api/admins  body: { email, password, role } */
export function createCreateAdminHandler(deps: AdminApiDeps): RouteHandler {
  const admins = new AdminsRepo(deps.sql);
  return withSuperadmin(deps.sql, async ({ req, admin }) => {
    const body = await parseJsonBody<{
      email?: unknown;
      password?: unknown;
      role?: unknown;
    }>(req);
    if (body instanceof Response) return body;

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role = body.role;
    if (!email.includes("@") || email.length > EMAIL_MAX) {
      return json({ error: "valid email is required" }, { status: 400 });
    }
    if (password.length < 8) {
      return json({ error: "password must be at least 8 characters" }, { status: 400 });
    }
    if (!isAdminRole(role)) {
      return json({ error: "role must be 'superadmin' or 'manager'" }, { status: 400 });
    }
    if (await admins.byEmail(email)) {
      return json({ error: "an admin with this email already exists" }, { status: 409 });
    }

    const created = await admins.create({ email, password, role });
    await new AuditLogRepo(deps.sql)
      .write({
        action: "admin.create",
        adminId: admin.adminId,
        targetKind: "admin",
        targetId: created.id,
        details: { email: created.email, role: created.role },
      })
      .catch((err) => console.error("[audit] admin.create write failed:", err));
    return json({
      admin: {
        id: created.id,
        email: created.email,
        role: created.role,
        created_at: created.created_at,
      },
    });
  });
}

/** DELETE /admin/api/admins/:id */
export function createDeleteAdminHandler(deps: AdminApiDeps): RouteHandler {
  const admins = new AdminsRepo(deps.sql);
  return withSuperadmin(deps.sql, async ({ params, admin }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    if (id === admin.adminId) {
      return json({ error: "you cannot delete your own account" }, { status: 400 });
    }
    const target = await admins.byId(id);
    if (!target) return json({ error: "not found" }, { status: 404 });
    if (target.role === "superadmin" && (await admins.countByRole("superadmin")) <= 1) {
      return json({ error: "cannot delete the last superadmin" }, { status: 400 });
    }

    await admins.deleteById(id);
    await new AuditLogRepo(deps.sql)
      .write({
        action: "admin.delete",
        adminId: admin.adminId,
        targetKind: "admin",
        targetId: id,
        details: { email: target.email, role: target.role },
      })
      .catch((err) => console.error("[audit] admin.delete write failed:", err));
    return json({ ok: true, deleted: id });
  });
}

/** POST /admin/api/admins/:id/password  body: { new_password }
 *  Superadmin resets another admin's password — no current password
 *  needed (that is the self-service /account/password flow). */
export function createResetAdminPasswordHandler(deps: AdminApiDeps): RouteHandler {
  const admins = new AdminsRepo(deps.sql);
  return withSuperadmin(deps.sql, async ({ req, params, admin }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const body = await parseJsonBody<{ new_password?: unknown }>(req);
    if (body instanceof Response) return body;
    const next = typeof body.new_password === "string" ? body.new_password : "";
    if (next.length < 8) {
      return json({ error: "new password must be at least 8 characters" }, { status: 400 });
    }
    const target = await admins.byId(id);
    if (!target) return json({ error: "not found" }, { status: 404 });

    await admins.updatePassword(id, next);
    await new AuditLogRepo(deps.sql)
      .write({
        action: "admin.password_reset",
        adminId: admin.adminId,
        targetKind: "admin",
        targetId: id,
        details: { email: target.email },
      })
      .catch((err) => console.error("[audit] admin.password_reset write failed:", err));
    return json({ ok: true });
  });
}
