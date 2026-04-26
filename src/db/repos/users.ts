import type { Database } from "bun:sqlite";

export type UserStatus =
  | "new"
  | "questionnaire_pending"
  | "qualified"
  | "won"
  | "lost";

export interface UserRow {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  status: UserStatus;
  profile_json: string | null;
  created_at: number;
  updated_at: number;
}

export class UsersRepo {
  constructor(private db: Database) {}

  byTgId(tgUserId: number): UserRow | null {
    return (
      this.db
        .query<UserRow, [number]>(
          "SELECT * FROM users WHERE tg_user_id = ? LIMIT 1",
        )
        .get(tgUserId) ?? null
    );
  }

  byId(id: number): UserRow | null {
    return (
      this.db
        .query<UserRow, [number]>("SELECT * FROM users WHERE id = ? LIMIT 1")
        .get(id) ?? null
    );
  }

  create(input: {
    tgUserId: number;
    tgUsername?: string | null;
    status?: UserStatus;
  }): UserRow {
    const status: UserStatus = input.status ?? "new";
    const row = this.db
      .query<UserRow, [number, string | null, UserStatus]>(
        `INSERT INTO users (tg_user_id, tg_username, status)
         VALUES (?, ?, ?)
         RETURNING *`,
      )
      .get(input.tgUserId, input.tgUsername ?? null, status);
    if (!row) throw new Error("Failed to create user");
    return row;
  }

  setStatus(id: number, status: UserStatus): void {
    this.db.run(
      "UPDATE users SET status = ?, updated_at = unixepoch() WHERE id = ?",
      [status, id],
    );
  }

  setProfile(id: number, profile: unknown): void {
    this.db.run(
      "UPDATE users SET profile_json = ?, updated_at = unixepoch() WHERE id = ?",
      [JSON.stringify(profile), id],
    );
  }

  list(limit = 100, offset = 0): UserRow[] {
    return this.db
      .query<UserRow, [number, number]>(
        "SELECT * FROM users ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset);
  }
}
