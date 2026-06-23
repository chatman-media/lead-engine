import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { admins, auditLog } from "@chatman-media/storage";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { Hono } from "hono";

/**
 * Per-tenant read-only audit-log API.
 *
 * Endpoints:
 *   GET /api/admin/audit-log — list (paginated by createdAt cursor)
 *   GET /api/admin/audit-log/export.csv — tenant-scoped CSV export
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
    const filters = auditFilters({
      tenantId,
      cursorRaw: c.req.query("cursor"),
      action: c.req.query("action"),
      targetKind: c.req.query("targetKind"),
      targetId: c.req.query("targetId"),
    });

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
        .where(and(...filters))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit + 1);
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && items.length > 0 ? (items[items.length - 1]?.createdAt ?? null) : null;

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

  app.get("/api/admin/audit-log/export.csv", async (c) => {
    const tenantId = c.var.tenantId;
    const limitParam = Number.parseInt(c.req.query("limit") ?? "10000", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 10000, 1), 10000);
    const filters = auditFilters({
      tenantId,
      cursorRaw: c.req.query("cursor"),
      action: c.req.query("action"),
      targetKind: c.req.query("targetKind"),
      targetId: c.req.query("targetId"),
    });

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
        .where(and(...filters))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit);
    });

    const csv = toAuditCsv(rows);
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${tenantId}.csv"`,
      "Cache-Control": "no-store",
    });
  });

  return app;
}

function auditFilters(opts: {
  tenantId: number;
  cursorRaw?: string;
  action?: string;
  targetKind?: string;
  targetId?: string;
}): SQL[] {
  const filters: SQL[] = [eq(auditLog.tenantId, opts.tenantId)];
  const cursor = opts.cursorRaw ? Number.parseInt(opts.cursorRaw, 10) : null;
  if (cursor !== null && Number.isFinite(cursor)) {
    filters.push(lt(auditLog.createdAt, cursor));
  }
  if (opts.action) filters.push(eq(auditLog.action, opts.action));
  if (opts.targetKind) filters.push(eq(auditLog.targetKind, opts.targetKind));
  if (opts.targetId) filters.push(eq(auditLog.targetId, opts.targetId));
  return filters;
}

function toAuditCsv(
  rows: Array<{
    id: number;
    createdAt: number;
    action: string;
    targetKind: string | null;
    targetId: string | null;
    adminId: number | null;
    adminEmail: string | null;
    detailsJson: string | null;
  }>,
): string {
  const header = [
    "id",
    "createdAt",
    "action",
    "targetKind",
    "targetId",
    "adminId",
    "adminEmail",
    "details",
  ];
  const lines = rows.map((row) =>
    [
      row.id,
      row.createdAt,
      row.action,
      row.targetKind,
      row.targetId,
      row.adminId,
      row.adminEmail,
      row.detailsJson ? JSON.stringify(safeParse(row.detailsJson)) : null,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${header.join(",")}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return { _raw: json };
  }
}
