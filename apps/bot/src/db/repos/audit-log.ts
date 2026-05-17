import type { Sql } from "../postgres.ts";

/** A single audit-log row — written by destructive admin endpoints
 *  (KB wipe, outcomes purge, lead delete, webhook delete, GDPR erase).
 *  `target_kind` + `target_id` identify the affected entity when
 *  applicable; both are nullable for global actions. */
export interface AuditLogRow {
  id: number;
  action: string;
  admin_id: number | null;
  target_kind: string | null;
  target_id: string | null;
  details_json: string | null;
  created_at: number;
}

export interface WriteAuditInput {
  action: string;
  adminId: number | null;
  targetKind?: string | null;
  /** Stored as TEXT — pass numeric ids as `String(id)` or use the
   *  `targetIdNum` convenience field. */
  targetId?: string | number | null;
  details?: unknown;
}

export class AuditLogRepo {
  constructor(private sql: Sql) {}

  /**
   * Write a single audit row. Best-effort: callers should call this
   * AFTER the destructive operation succeeds, but a failure here must
   * NOT abort the operation — wrap in `.catch()`. The schema is
   * intentionally permissive (TEXT target_id, JSON details) so adding
   * new action kinds doesn't require a migration.
   */
  async write(input: WriteAuditInput): Promise<AuditLogRow> {
    const targetId =
      input.targetId === undefined || input.targetId === null ? null : String(input.targetId);
    const detailsJson =
      input.details === undefined || input.details === null ? null : JSON.stringify(input.details);
    const [row] = await this.sql<AuditLogRow[]>`
      INSERT INTO audit_log (action, admin_id, target_kind, target_id, details_json)
      VALUES (${input.action}, ${input.adminId}, ${input.targetKind ?? null}, ${targetId}, ${detailsJson})
      RETURNING *
    `;
    if (!row) throw new Error("audit_log insert returned no row");
    return row;
  }

  /** Recent rows for the admin UI viewer. */
  async list(
    opts: { limit?: number; action?: string; adminId?: number } = {},
  ): Promise<AuditLogRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    if (opts.action && opts.adminId !== undefined) {
      return this.sql<AuditLogRow[]>`
        SELECT * FROM audit_log
        WHERE action = ${opts.action} AND admin_id = ${opts.adminId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `;
    }
    if (opts.action) {
      return this.sql<AuditLogRow[]>`
        SELECT * FROM audit_log
        WHERE action = ${opts.action}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `;
    }
    if (opts.adminId !== undefined) {
      return this.sql<AuditLogRow[]>`
        SELECT * FROM audit_log
        WHERE admin_id = ${opts.adminId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `;
    }
    return this.sql<AuditLogRow[]>`
      SELECT * FROM audit_log
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
  }
}
