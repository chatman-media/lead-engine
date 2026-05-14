import type { Sql } from "../postgres.ts";

export interface AdminRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: number;
}

const MIN_PASSWORD_LEN = 8;

export class AdminsRepo {
  constructor(private sql: Sql) {}

  async create(input: { email: string; password: string }): Promise<AdminRow> {
    if (input.password.length < MIN_PASSWORD_LEN) {
      throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`);
    }
    const email = input.email.trim().toLowerCase();
    const hash = await Bun.password.hash(input.password, {
      algorithm: "argon2id",
    });
    const [row] = await this.sql<AdminRow[]>`
      INSERT INTO admins (email, password_hash) VALUES (${email}, ${hash}) RETURNING *
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
}
