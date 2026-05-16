import type { Sql } from "../postgres.ts";

export type ConversationMode = "ai" | "queued" | "human";

/**
 * Which channel a conversation belongs to. A candidate writing to both the
 * BotAPI bot and the operator's personal account holds two independent
 * conversations — test traffic via `bot` never pollutes real `userbot` leads.
 */
export type ConversationSource = "bot" | "userbot" | "self_play";

export interface ConversationRow {
  id: number;
  user_id: number;
  source: ConversationSource;
  mode: ConversationMode;
  escalated_at: number | null;
  assigned_admin_id: number | null;
  last_message_at: number | null;
  created_at: number;
  style_id: number | null;
  experiment_id: number | null;
  current_stage: string | null;
  summary_json: string | null;
  meta_json: string | null;
}

export interface ConversationSummary {
  summary: string;
  summarizedThroughMsgId: number;
  updatedAt: number;
}

export class ConversationsRepo {
  constructor(private sql: Sql) {}

  /**
   * Look up a candidate's conversation. A user can hold one conversation per
   * channel (`UNIQUE(user_id, source)`); when more than one exists this
   * prefers the `userbot` row — the real funnel — over the `bot` test
   * channel, so lead-pipeline callers resolve the working conversation.
   */
  async byUserId(userId: number): Promise<ConversationRow | null> {
    const [row] = await this.sql<ConversationRow[]>`
      SELECT * FROM conversations
      WHERE user_id = ${userId}
      ORDER BY (source = 'userbot') DESC, id ASC
      LIMIT 1
    `;
    return row ?? null;
  }

  async byId(id: number): Promise<ConversationRow | null> {
    const [row] = await this.sql<ConversationRow[]>`
      SELECT * FROM conversations WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async ensureForUser(
    userId: number,
    source: ConversationSource = "bot",
  ): Promise<ConversationRow> {
    // ON CONFLICT against the UNIQUE(user_id, source) index collapses the
    // SELECT-then-INSERT race two simultaneous inbound messages used to
    // trigger (both saw "no row", both inserted). DO UPDATE on a sentinel
    // column lets RETURNING fire for the existing row too.
    const [row] = await this.sql<ConversationRow[]>`
      INSERT INTO conversations (user_id, source) VALUES (${userId}, ${source})
      ON CONFLICT (user_id, source) DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING *
    `;
    if (!row) throw new Error("Failed to create conversation");
    return row;
  }

  async setMode(
    id: number,
    mode: ConversationMode,
    assignedAdminId: number | null = null,
  ): Promise<void> {
    if (mode === "ai") {
      await this.sql`
        UPDATE conversations
        SET mode = 'ai', escalated_at = NULL, assigned_admin_id = NULL
        WHERE id = ${id}
      `;
      return;
    }
    if (mode === "queued") {
      await this.sql`
        UPDATE conversations
        SET mode = 'queued', escalated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
        WHERE id = ${id}
      `;
      return;
    }
    await this.sql`
      UPDATE conversations
      SET mode = 'human', assigned_admin_id = ${assignedAdminId}
      WHERE id = ${id}
    `;
  }

  async touch(id: number): Promise<void> {
    await this.sql`
      UPDATE conversations SET last_message_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
  }

  async assignStyle(
    id: number,
    styleId: number,
    experimentId: number | null = null,
  ): Promise<void> {
    await this.sql`
      UPDATE conversations SET style_id = ${styleId}, experiment_id = ${experimentId} WHERE id = ${id}
    `;
  }

  async setCurrentStage(id: number, stage: string): Promise<void> {
    await this.sql`
      UPDATE conversations SET current_stage = ${stage} WHERE id = ${id}
    `;
  }

  async getSummary(id: number): Promise<ConversationSummary | null> {
    const row = await this.byId(id);
    if (!row?.summary_json) return null;
    try {
      const parsed = JSON.parse(row.summary_json) as ConversationSummary;
      if (typeof parsed.summary === "string" && typeof parsed.summarizedThroughMsgId === "number") {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  async setSummary(id: number, summary: string, summarizedThroughMsgId: number): Promise<void> {
    const payload: ConversationSummary = {
      summary,
      summarizedThroughMsgId,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    await this.sql`
      UPDATE conversations SET summary_json = ${JSON.stringify(payload)} WHERE id = ${id}
    `;
  }

  getStallCount(conv: ConversationRow): number {
    if (!conv.meta_json) return 0;
    try {
      const meta = JSON.parse(conv.meta_json) as Record<string, unknown>;
      return typeof meta.stall_count === "number" ? meta.stall_count : 0;
    } catch {
      return 0;
    }
  }

  async setStallCount(id: number, count: number): Promise<void> {
    const [row] = await this.sql<{ meta_json: string | null }[]>`
      SELECT meta_json FROM conversations WHERE id = ${id}
    `;
    let meta: Record<string, unknown> = {};
    if (row?.meta_json) {
      try {
        meta = JSON.parse(row.meta_json) as Record<string, unknown>;
      } catch {
        /* ignore corrupt JSON */
      }
    }
    meta.stall_count = count;
    await this.sql`
      UPDATE conversations SET meta_json = ${JSON.stringify(meta)} WHERE id = ${id}
    `;
  }

  async deleteById(id: number): Promise<boolean> {
    const result = await this.sql`DELETE FROM conversations WHERE id = ${id}`;
    return result.count > 0;
  }

  async list(
    opts: { onlyEscalated?: boolean; limit?: number; source?: ConversationSource } = {},
  ): Promise<Array<ConversationRow & { tg_user_id: number; tg_username: string | null }>> {
    const limit = opts.limit ?? 100;
    // `source` filter is optional and composes with `onlyEscalated`. When
    // omitted, all channels are returned (admin UI shows a per-row badge).
    const sourceClause = opts.source ? this.sql`AND c.source = ${opts.source}` : this.sql``;
    if (opts.onlyEscalated) {
      return this.sql<Array<ConversationRow & { tg_user_id: number; tg_username: string | null }>>`
        SELECT c.*, u.tg_user_id, u.tg_username
        FROM conversations c
        JOIN users u ON u.id = c.user_id
        WHERE c.mode IN ('queued','human') ${sourceClause}
        ORDER BY (c.mode = 'queued') DESC, c.last_message_at DESC NULLS LAST
        LIMIT ${limit}
      `;
    }
    return this.sql<Array<ConversationRow & { tg_user_id: number; tg_username: string | null }>>`
      SELECT c.*, u.tg_user_id, u.tg_username
      FROM conversations c
      JOIN users u ON u.id = c.user_id
      WHERE TRUE ${sourceClause}
      ORDER BY (c.mode = 'queued') DESC, c.last_message_at DESC NULLS LAST
      LIMIT ${limit}
    `;
  }
}
