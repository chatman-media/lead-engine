import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export interface SessionRow {
  id: string;
  admin_id: number;
  expires_at: number;
  created_at: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14;

function generateId(): string {
  return randomBytes(24).toString("base64url");
}

export class SessionsRepo {
  constructor(private db: Database) {}

  issue(adminId: number, opts: { ttlSeconds?: number } = {}): string {
    const id = generateId();
    const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    this.db.run(`INSERT INTO sessions (id, admin_id, expires_at) VALUES (?, ?, ?)`, [
      id,
      adminId,
      expiresAt,
    ]);
    return id;
  }

  /** Returns admin_id or null. Garbage-collects the row if expired. */
  adminIdFor(id: string): number | null {
    const row = this.db
      .query<SessionRow, [string]>(`SELECT * FROM sessions WHERE id = ? LIMIT 1`)
      .get(id);
    if (!row) return null;
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at <= now) {
      this.db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
      return null;
    }
    return row.admin_id;
  }

  revoke(id: string): void {
    this.db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
  }

  /** Bulk delete expired sessions; useful for startup or cron. */
  purgeExpired(): number {
    const before =
      this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM sessions`).get()?.n ?? 0;
    this.db.run(`DELETE FROM sessions WHERE expires_at <= unixepoch()`);
    const after =
      this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM sessions`).get()?.n ?? 0;
    return before - after;
  }
}
