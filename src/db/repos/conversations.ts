import type { Database } from "bun:sqlite";

export type ConversationMode = "ai" | "queued" | "human";

export interface ConversationRow {
  id: number;
  user_id: number;
  mode: ConversationMode;
  escalated_at: number | null;
  assigned_admin_id: number | null;
  last_message_at: number | null;
  created_at: number;
  // Sales-engine columns (added in migration 003). Null on legacy rows and
  // on conversations created when no experiment is running.
  style_id: number | null;
  experiment_id: number | null;
  current_stage: string | null;
}

export class ConversationsRepo {
  constructor(private db: Database) {}

  byUserId(userId: number): ConversationRow | null {
    return (
      this.db
        .query<ConversationRow, [number]>(
          "SELECT * FROM conversations WHERE user_id = ? LIMIT 1",
        )
        .get(userId) ?? null
    );
  }

  byId(id: number): ConversationRow | null {
    return (
      this.db
        .query<ConversationRow, [number]>(
          "SELECT * FROM conversations WHERE id = ? LIMIT 1",
        )
        .get(id) ?? null
    );
  }

  ensureForUser(userId: number): ConversationRow {
    const existing = this.byUserId(userId);
    if (existing) return existing;
    const row = this.db
      .query<ConversationRow, [number]>(
        `INSERT INTO conversations (user_id) VALUES (?) RETURNING *`,
      )
      .get(userId);
    if (!row) throw new Error("Failed to create conversation");
    return row;
  }

  setMode(
    id: number,
    mode: ConversationMode,
    assignedAdminId: number | null = null,
  ) {
    if (mode === "ai") {
      this.db.run(
        `UPDATE conversations
         SET mode = 'ai', escalated_at = NULL, assigned_admin_id = NULL
         WHERE id = ?`,
        [id],
      );
      return;
    }
    if (mode === "queued") {
      this.db.run(
        `UPDATE conversations
         SET mode = 'queued', escalated_at = unixepoch()
         WHERE id = ?`,
        [id],
      );
      return;
    }
    this.db.run(
      `UPDATE conversations
       SET mode = 'human', assigned_admin_id = ?
       WHERE id = ?`,
      [assignedAdminId, id],
    );
  }

  touch(id: number) {
    this.db.run(
      "UPDATE conversations SET last_message_at = unixepoch() WHERE id = ?",
      [id],
    );
  }

  /**
   * Pin a sales-engine style + experiment to this conversation. Idempotent —
   * setting again with the same ids is a no-op. Once assigned, A/B routing
   * MUST stick (else a prospect on retry could see a different persona).
   */
  assignStyle(id: number, styleId: number, experimentId: number | null = null): void {
    this.db.run(
      `UPDATE conversations SET style_id = ?, experiment_id = ? WHERE id = ?`,
      [styleId, experimentId, id],
    );
  }

  /** Persist the latest funnel stage so it survives process restarts. */
  setCurrentStage(id: number, stage: string): void {
    this.db.run(`UPDATE conversations SET current_stage = ? WHERE id = ?`, [stage, id]);
  }

  /**
   * Hard-deletes a conversation and (via FK CASCADE) all its messages.
   * The next inbound Telegram message from the same user will recreate
   * a fresh conversation in default mode='ai', escalated_at=NULL.
   */
  deleteById(id: number): boolean {
    const res = this.db.run(`DELETE FROM conversations WHERE id = ?`, [id]);
    return res.changes > 0;
  }

  list(opts: { onlyEscalated?: boolean; limit?: number } = {}): Array<
    ConversationRow & { tg_user_id: number; tg_username: string | null }
  > {
    const limit = opts.limit ?? 100;
    const where = opts.onlyEscalated ? "WHERE c.mode IN ('queued','human')" : "";
    return this.db
      .query<
        ConversationRow & { tg_user_id: number; tg_username: string | null },
        [number]
      >(
        `SELECT c.*, u.tg_user_id, u.tg_username
         FROM conversations c
         JOIN users u ON u.id = c.user_id
         ${where}
         ORDER BY (c.mode = 'queued') DESC, c.last_message_at DESC NULLS LAST
         LIMIT ?`,
      )
      .all(limit);
  }
}
