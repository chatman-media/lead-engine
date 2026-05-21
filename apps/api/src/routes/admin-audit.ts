import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { admins, auditLog } from "@chatman-media/storage";
import { and, desc, eq, lt } from "drizzle-orm";
import { Hono } from "hono";

/**
 * Per-tenant read-only audit-log API.
 *
 * Endpoints:
 *   GET /api/admin/audit-log — list (paginated by createdAt cursor)
 *
 * Возвращает действия admin'ов конкретного tenant'а (RLS гарантирует
 * изоляцию). Запись в audit_log происходит из других routes через
 * apps/api/src/lib/audit.ts.
 */
export interface AdminAuditRoutesOpts {
  db: Db;
}

export function makeAdminAuditRoutes(opts: AdminAuditRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/audit-log?limit=N&cursor=<epoch>
   * Returns: {
   *   items: [{ id, action, targetKind, targetId, details, adminEmail, createdAt }],
   *   nextCursor?: number
   * }
   */
  app.get("/api/admin/audit-log", async (c) => {
    const tenantId = c.var.tenantId;
    const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 200);
    const cursorRaw = c.req.query("cursor");
    const cursor = cursorRaw ? Number.parseInt(cursorRaw, 10) : null;

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select({
          id: auditLog.id,
          action: auditLog.action,
          targetKind: auditLog.targetKind,
          targetId: auditLog.targetId,
          detailsJson: auditLog.detailsJson,
          adminId: auditLog.adminId,
          adminEmail: admins.email,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .leftJoin(admins, eq(admins.id, auditLog.adminId))
        .where(
          cursor !== null && Number.isFinite(cursor)
            ? and(eq(auditLog.tenantId, tenantId), lt(auditLog.createdAt, cursor))
            : eq(auditLog.tenantId, tenantId),
        )
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit + 1);
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && items.length > 0 ? items[items.length - 1]?.createdAt ?? null : null;

    return c.json({
      items: items.map((r) => ({
        id: r.id,
        action: r.action,
        targetKind: r.targetKind,
        targetId: r.targetId,
        details: r.detailsJson ? safeParse(r.detailsJson) : null,
        adminId: r.adminId,
        adminEmail: r.adminEmail,
        createdAt: r.createdAt,
      })),
      ...(nextCursor !== null ? { nextCursor } : {}),
    });
  });

  return app;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return { _raw: json };
  }
}
