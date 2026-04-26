import type { Database } from "bun:sqlite";

export interface AdminRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: number;
}

const MIN_PASSWORD_LEN = 8;

export class AdminsRepo {
  constructor(private db: Database) {}

  async create(input: {
    email: string;
    password: string;
  }): Promise<AdminRow> {
    if (input.password.length < MIN_PASSWORD_LEN) {
      throw new Error(
        `password must be at least ${MIN_PASSWORD_LEN} characters`,
      );
    }
    const email = input.email.trim().toLowerCase();
    const hash = await Bun.password.hash(input.password, {
      algorithm: "argon2id",
    });
    const row = this.db
      .query<AdminRow, [string, string]>(
        `INSERT INTO admins (email, password_hash) VALUES (?, ?) RETURNING *`,
      )
      .get(email, hash);
    if (!row) throw new Error("failed to insert admin");
    return row;
  }

  byEmail(email: string): AdminRow | null {
    return (
      this.db
        .query<AdminRow, [string]>(
          `SELECT * FROM admins WHERE email = ? LIMIT 1`,
        )
        .get(email.trim().toLowerCase()) ?? null
    );
  }

  byId(id: number): AdminRow | null {
    return (
      this.db
        .query<AdminRow, [number]>(`SELECT * FROM admins WHERE id = ? LIMIT 1`)
        .get(id) ?? null
    );
  }

  async verifyPassword(
    email: string,
    password: string,
  ): Promise<AdminRow | null> {
    const row = this.byEmail(email);
    if (!row) return null;
    const ok = await Bun.password.verify(password, row.password_hash);
    return ok ? row : null;
  }
}
