import type { Sql } from "../postgres.ts";

/**
 * Admin roles:
 *   - superadmin: full access — destructive operations, system settings,
 *     telegram webhook, KB wipe.
 *   - manager: day-to-day operations — leads, chats, KB content, analytics.
 *     Cannot run destructive/system actions.
 */
export const ADMIN_ROLES = ["superadmin", "manager"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);
}

export interface AdminRow {
  id: number;
  email: string;
  password_hash: string;
  role: AdminRole;
  created_at: number;
}

/** Admin row safe to expose over the API — no password hash. */
export interface AdminSummary {
  id: number;
  email: string;
  role: AdminRole;
  created_at: number;
}

const MIN_PASSWORD_LEN = 8;

export class AdminsRepo {
  constructor(private sql: Sql) {}

  async create(input: { email: string; password: string; role?: AdminRole }): Promise<AdminRow> {
    if (input.password.length < MIN_PASSWORD_LEN) {
      throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`);
    }
    // Defaults to superadmin to match the DB column default — managers are
    // always created with an explicit role.
    const role: AdminRole = input.role ?? "superadmin";
    const email = input.email.trim().toLowerCase();
    const hash = await Bun.password.hash(input.password, {
      algorithm: "argon2id",
    });
    const [row] = await this.sql<AdminRow[]>`
      INSERT INTO admins (email, password_hash, role)
      VALUES (${email}, ${hash}, ${role})
      RETURNING *
    `;
    if (!row) throw new Error("failed to insert admin");
    return row;
  }

  async byEmail(email: string): Promise<AdminRow | null> {
    const [row] = await this.sql<AdminRow[]>`
      SELECT * FROM admins WHERE email = ${email.trim().toLowerCase()} LIMIT 1
    `;
    return row ?? null;
  }

  async byId(id: number): Promise<AdminRow | null> {
    const [row] = await this.sql<AdminRow[]>`
      SELECT * FROM admins WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async verifyPassword(email: string, password: string): Promise<AdminRow | null> {
    const row = await this.byEmail(email);
    if (!row) return null;
    const ok = await Bun.password.verify(password, row.password_hash);
    return ok ? row : null;
  }

  /** Replace an admin's password. Caller is responsible for verifying the
   *  current password first (see the change-password handler). */
  async updatePassword(id: number, newPassword: string): Promise<void> {
    if (newPassword.length < MIN_PASSWORD_LEN) {
      throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`);
    }
    const hash = await Bun.password.hash(newPassword, { algorithm: "argon2id" });
    await this.sql`UPDATE admins SET password_hash = ${hash} WHERE id = ${id}`;
  }

  /** All admins, password hash omitted — for the operator-management UI. */
  async list(): Promise<AdminSummary[]> {
    return this.sql<AdminSummary[]>`
      SELECT id, email, role, created_at FROM admins ORDER BY created_at ASC, id ASC
    `;
  }

  /** Delete an admin by id. Returns true when a row was removed. Sessions
   *  cascade via the FK. Caller guards against self-delete / last-superadmin. */
  async deleteById(id: number): Promise<boolean> {
    const rows = await this.sql`DELETE FROM admins WHERE id = ${id}`;
    return rows.count > 0;
  }

  /** Count admins holding a given role — used to block removing the last
   *  superadmin (which would lock everyone out of destructive ops). */
  async countByRole(role: AdminRole): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n FROM admins WHERE role = ${role}
    `;
    return row?.n ?? 0;
  }
}
