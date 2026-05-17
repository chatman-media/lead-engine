import { randomBytes } from "node:crypto";
import type { Sql } from "../postgres.ts";

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
  constructor(private sql: Sql) {}

  async issue(adminId: number, opts: { ttlSeconds?: number } = {}): Promise<string> {
    const id = generateId();
    const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    await this.sql`
      INSERT INTO sessions (id, admin_id, expires_at) VALUES (${id}, ${adminId}, ${expiresAt})
    `;
    return id;
  }

  async adminIdFor(id: string): Promise<number | null> {
    const [row] = await this.sql<SessionRow[]>`
      SELECT * FROM sessions WHERE id = ${id} LIMIT 1
    `;
    if (!row) return null;
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at <= now) {
      await this.sql`DELETE FROM sessions WHERE id = ${id}`;
      return null;
    }
    return row.admin_id;
  }

  async revoke(id: string): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE id = ${id}`;
  }

  async purgeExpired(): Promise<number> {
    const [before] = await this.sql<{ n: number }[]>`SELECT COUNT(*)::INTEGER AS n FROM sessions`;
    await this.sql`DELETE FROM sessions WHERE expires_at <= EXTRACT(EPOCH FROM NOW())::INTEGER`;
    const [after] = await this.sql<{ n: number }[]>`SELECT COUNT(*)::INTEGER AS n FROM sessions`;
    return (before?.n ?? 0) - (after?.n ?? 0);
  }
}
