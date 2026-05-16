import type { PhotoClass } from "../../rag/vision.ts";
import type { Sql } from "../postgres.ts";

export type MessageRole = "user" | "assistant" | "human" | "system";

export interface MessageRow {
  id: number;
  conversation_id: number;
  role: MessageRole;
  text: string;
  tg_message_id: number | null;
  meta_json: string | null;
  created_at: number;
  stage: string | null;
}

export class MessagesRepo {
  constructor(private sql: Sql) {}

  async add(input: {
    conversationId: number;
    role: MessageRole;
    text: string;
    tgMessageId?: number | null;
    meta?: unknown;
    stage?: string | null;
  }): Promise<MessageRow> {
    const metaJson = input.meta === undefined ? null : JSON.stringify(input.meta);
    const [row] = await this.sql<MessageRow[]>`
      INSERT INTO messages (conversation_id, role, text, tg_message_id, meta_json, stage)
      VALUES (${input.conversationId}, ${input.role}, ${input.text}, ${input.tgMessageId ?? null}, ${metaJson}, ${input.stage ?? null})
      RETURNING *
    `;
    if (!row) throw new Error("Failed to insert message");
    return row;
  }

  /**
   * Idempotent insert for inbound Telegram messages.
   */
  async addUserMessageIfNew(input: {
    conversationId: number;
    text: string;
    tgMessageId: number;
    meta?: unknown;
  }): Promise<{ isNew: boolean; message: MessageRow }> {
    const metaJson = input.meta === undefined ? null : JSON.stringify(input.meta);
    const [inserted] = await this.sql<MessageRow[]>`
      INSERT INTO messages (conversation_id, role, text, tg_message_id, meta_json)
      VALUES (${input.conversationId}, 'user', ${input.text}, ${input.tgMessageId}, ${metaJson})
      ON CONFLICT (conversation_id, tg_message_id)
        WHERE role = 'user' AND tg_message_id IS NOT NULL
      DO NOTHING
      RETURNING *
    `;
    if (inserted) return { isNew: true, message: inserted };

    const [existing] = await this.sql<MessageRow[]>`
      SELECT * FROM messages
      WHERE conversation_id = ${input.conversationId} AND tg_message_id = ${input.tgMessageId} AND role = 'user'
      LIMIT 1
    `;
    if (!existing) {
      throw new Error("addUserMessageIfNew: insert was no-op but no existing row found");
    }
    return { isNew: false, message: existing };
  }

  async listByConversation(conversationId: number, limit = 200): Promise<MessageRow[]> {
    return this.sql<MessageRow[]>`
      SELECT * FROM messages
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
    `;
  }

  async recentForContext(conversationId: number, limit = 10): Promise<MessageRow[]> {
    const rows = await this.sql<MessageRow[]>`
      SELECT * FROM messages
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.reverse();
  }

  async setMeta(id: number, meta: unknown): Promise<boolean> {
    const json = meta === null || meta === undefined ? null : JSON.stringify(meta);
    const result = await this.sql`UPDATE messages SET meta_json = ${json} WHERE id = ${id}`;
    return result.count > 0;
  }

  async byId(id: number): Promise<MessageRow | null> {
    const [row] = await this.sql<MessageRow[]>`
      SELECT * FROM messages WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async countMediaForConversation(
    conversationId: number,
  ): Promise<{ photos: number; videos: number }> {
    const rows = await this.sql<{ kind: string; n: number }[]>`
      SELECT (meta_json::jsonb)->'media'->>'type' AS kind, COUNT(*)::INTEGER AS n
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND role = 'user'
        AND meta_json IS NOT NULL
        AND (meta_json::jsonb)->'media'->>'type' IS NOT NULL
      GROUP BY kind
    `;
    let photos = 0;
    let videos = 0;
    for (const r of rows) {
      if (r.kind === "photo") photos = r.n;
      else if (r.kind === "video") videos = r.n;
    }
    return { photos, videos };
  }

  /**
   * Inbound photo messages that haven't been vision-classified yet
   * (`meta_json.media.photo_class` absent). Used by the
   * `runPhotoClassification` hook to find work. Oldest first.
   */
  async unclassifiedPhotos(
    conversationId: number,
  ): Promise<{ id: number; file_id: string; mime_type: string | null }[]> {
    return this.sql<{ id: number; file_id: string; mime_type: string | null }[]>`
      SELECT
        id,
        (meta_json::jsonb)->'media'->>'file_id' AS file_id,
        (meta_json::jsonb)->'media'->>'mime_type' AS mime_type
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND role = 'user'
        AND meta_json IS NOT NULL
        AND (meta_json::jsonb)->'media'->>'type' = 'photo'
        AND (meta_json::jsonb)->'media'->'photo_class' IS NULL
        AND (meta_json::jsonb)->'media'->>'file_id' IS NOT NULL
      ORDER BY id ASC
    `;
  }

  /** Stamps a vision class onto a photo message's `meta_json.media`. */
  async setPhotoClass(id: number, photoClass: PhotoClass): Promise<boolean> {
    const result = await this.sql`
      UPDATE messages
      SET meta_json = jsonb_set(
        meta_json::jsonb, '{media,photo_class}', to_jsonb(${photoClass}::text)
      )::text
      WHERE id = ${id} AND meta_json IS NOT NULL
    `;
    return result.count > 0;
  }

  /** Counts classified photos per vision class for a conversation. */
  async countPhotosByClass(conversationId: number): Promise<Record<PhotoClass, number>> {
    const rows = await this.sql<{ cls: string; n: number }[]>`
      SELECT (meta_json::jsonb)->'media'->>'photo_class' AS cls, COUNT(*)::INTEGER AS n
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND role = 'user'
        AND meta_json IS NOT NULL
        AND (meta_json::jsonb)->'media'->>'type' = 'photo'
        AND (meta_json::jsonb)->'media'->'photo_class' IS NOT NULL
      GROUP BY cls
    `;
    const counts: Record<PhotoClass, number> = {
      passport: 0,
      full_body: 0,
      portrait: 0,
      other: 0,
    };
    for (const r of rows) {
      if (
        r.cls === "passport" ||
        r.cls === "full_body" ||
        r.cls === "portrait" ||
        r.cls === "other"
      ) {
        counts[r.cls] = r.n;
      }
    }
    return counts;
  }
}
