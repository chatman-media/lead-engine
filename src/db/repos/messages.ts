import type { Database } from "bun:sqlite";

export type MessageRole = "user" | "assistant" | "human" | "system";

export interface MessageRow {
  id: number;
  conversation_id: number;
  role: MessageRole;
  text: string;
  tg_message_id: number | null;
  meta_json: string | null;
  created_at: number;
}

export class MessagesRepo {
  constructor(private db: Database) {}

  add(input: {
    conversationId: number;
    role: MessageRole;
    text: string;
    tgMessageId?: number | null;
    meta?: unknown;
  }): MessageRow {
    const row = this.db
      .query<
        MessageRow,
        [number, MessageRole, string, number | null, string | null]
      >(
        `INSERT INTO messages (conversation_id, role, text, tg_message_id, meta_json)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.conversationId,
        input.role,
        input.text,
        input.tgMessageId ?? null,
        input.meta === undefined ? null : JSON.stringify(input.meta),
      );
    if (!row) throw new Error("Failed to insert message");
    return row;
  }

  /**
   * Idempotent insert for inbound Telegram messages. Telegram retries
   * webhook deliveries with the same `tg_message_id` when our handler
   * doesn't ack within ~60s — without dedup that produces ghost rows
   * in the admin UI ("the same message every minute"). Pair this with
   * the partial UNIQUE index from migration 002.
   *
   * Returns `{isNew: true, message}` if this is the first time we see
   * `(conversationId, tgMessageId)`, or `{isNew: false, message}` with
   * the existing row if it's a retry.
   */
  addUserMessageIfNew(input: {
    conversationId: number;
    text: string;
    tgMessageId: number;
  }): { isNew: boolean; message: MessageRow } {
    const inserted = this.db
      .query<
        MessageRow,
        [number, string, number]
      >(
        `INSERT INTO messages (conversation_id, role, text, tg_message_id)
         VALUES (?, 'user', ?, ?)
         ON CONFLICT(conversation_id, tg_message_id)
           WHERE role = 'user' AND tg_message_id IS NOT NULL
           DO NOTHING
         RETURNING *`,
      )
      .get(input.conversationId, input.text, input.tgMessageId);
    if (inserted) return { isNew: true, message: inserted };

    const existing = this.db
      .query<MessageRow, [number, number]>(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND tg_message_id = ? AND role = 'user'
         LIMIT 1`,
      )
      .get(input.conversationId, input.tgMessageId);
    if (!existing) {
      throw new Error(
        "addUserMessageIfNew: insert was no-op but no existing row found",
      );
    }
    return { isNew: false, message: existing };
  }

  listByConversation(conversationId: number, limit = 200): MessageRow[] {
    return this.db
      .query<MessageRow, [number, number]>(
        `SELECT * FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(conversationId, limit);
  }

  recentForContext(conversationId: number, limit = 10): MessageRow[] {
    const rows = this.db
      .query<MessageRow, [number, number]>(
        `SELECT * FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(conversationId, limit);
    return rows.reverse();
  }
}
