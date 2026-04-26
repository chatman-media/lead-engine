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
