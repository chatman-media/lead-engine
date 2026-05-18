import type { InternalPassportIdentity, PassportIdentity, PhotoClass } from "../../rag/vision.ts";
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
   * Count of inbound videos whose caption explicitly says it is a dance
   * video ("видео танца", "танец", "dance"). The intake extractor uses
   * this to mark `dance_video_received` from the candidate's own label
   * rather than the coarse ">=3 videos" heuristic.
   */
  async countDanceVideoCaptions(conversationId: number): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND role = 'user'
        AND meta_json IS NOT NULL
        AND (meta_json::jsonb)->'media'->>'type' = 'video'
        AND text ~* '(танц|dance)'
    `;
    return row?.n ?? 0;
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

  /**
   * Stamps passport identity fields extracted from a passport photo onto
   * `meta_json.media.passport`. Built server-side with
   * `jsonb_build_object` + `jsonb_strip_nulls` so unread fields are
   * dropped: an all-empty extraction lands as `{}`, which still marks the
   * photo as "attempted" so it isn't retried forever on an unreadable
   * scan, yet is treated as "no data" by `passportFieldsForConversation`.
   */
  async setPassportFields(id: number, fields: PassportIdentity): Promise<boolean> {
    const result = await this.sql`
      UPDATE messages
      SET meta_json = jsonb_set(
        meta_json::jsonb,
        '{media,passport}',
        jsonb_strip_nulls(jsonb_build_object(
          'family_name', ${fields.family_name ?? null}::text,
          'given_name', ${fields.given_name ?? null}::text,
          'passport_number', ${fields.passport_number ?? null}::text,
          'passport_expiry', ${fields.passport_expiry ?? null}::text,
          'date_of_birth', ${fields.date_of_birth ?? null}::text,
          'nationality', ${fields.nationality ?? null}::text,
          'place_of_birth', ${fields.place_of_birth ?? null}::text
        ))
      )::text
      WHERE id = ${id} AND meta_json IS NOT NULL
    `;
    return result.count > 0;
  }

  /**
   * Photo messages classified as `passport` that have not had their
   * identity fields extracted yet (`meta_json.media.passport` absent).
   * Used by the passport-extraction step in `runPhotoClassification`.
   * Oldest first.
   */
  async passportPhotosNeedingExtraction(
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
        AND (meta_json::jsonb)->'media'->>'photo_class' = 'passport'
        AND (meta_json::jsonb)->'media'->'passport' IS NULL
        AND (meta_json::jsonb)->'media'->>'file_id' IS NOT NULL
      ORDER BY id ASC
    `;
  }

  /**
   * Latest non-empty passport identity extracted in a conversation, or
   * `null` when none. Read by the intake hook to merge passport data
   * into the lead's intake fields.
   */
  async passportFieldsForConversation(conversationId: number): Promise<PassportIdentity | null> {
    const [row] = await this.sql<{ passport: string }[]>`
      SELECT ((meta_json::jsonb)->'media'->'passport')::text AS passport
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND role = 'user'
        AND meta_json IS NOT NULL
        AND (meta_json::jsonb)->'media'->'passport' IS NOT NULL
        AND (meta_json::jsonb)->'media'->'passport' != '{}'::jsonb
      ORDER BY id DESC
      LIMIT 1
    `;
    if (!row?.passport) return null;
    try {
      return JSON.parse(row.passport) as PassportIdentity;
    } catch {
      return null;
    }
  }

  /**
   * Stamps internal-passport identity fields onto
   * `meta_json.media.internal_passport`. Same `{}`-as-attempted
   * semantics as `setPassportFields`.
   */
  async setInternalPassportFields(id: number, fields: InternalPassportIdentity): Promise<boolean> {
    const result = await this.sql`
      UPDATE messages
      SET meta_json = jsonb_set(
        meta_json::jsonb,
        '{media,internal_passport}',
        jsonb_strip_nulls(jsonb_build_object(
          'national_id_number', ${fields.national_id_number ?? null}::text,
          'date_of_birth', ${fields.date_of_birth ?? null}::text,
          'place_of_birth', ${fields.place_of_birth ?? null}::text
        ))
      )::text
      WHERE id = ${id} AND meta_json IS NOT NULL
    `;
    return result.count > 0;
  }

  /**
   * Photo messages classified as `internal_passport` that have not had
   * their identity fields extracted yet
   * (`meta_json.media.internal_passport` absent). Oldest first.
   */
  async internalPassportPhotosNeedingExtraction(
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
        AND (meta_json::jsonb)->'media'->>'photo_class' = 'internal_passport'
        AND (meta_json::jsonb)->'media'->'internal_passport' IS NULL
        AND (meta_json::jsonb)->'media'->>'file_id' IS NOT NULL
      ORDER BY id ASC
    `;
  }

  /**
   * Latest non-empty internal-passport identity extracted in a
   * conversation, or `null` when none.
   */
  async internalPassportFieldsForConversation(
    conversationId: number,
  ): Promise<InternalPassportIdentity | null> {
    const [row] = await this.sql<{ internal_passport: string }[]>`
      SELECT ((meta_json::jsonb)->'media'->'internal_passport')::text AS internal_passport
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND role = 'user'
        AND meta_json IS NOT NULL
        AND (meta_json::jsonb)->'media'->'internal_passport' IS NOT NULL
        AND (meta_json::jsonb)->'media'->'internal_passport' != '{}'::jsonb
      ORDER BY id DESC
      LIMIT 1
    `;
    if (!row?.internal_passport) return null;
    try {
      return JSON.parse(row.internal_passport) as InternalPassportIdentity;
    } catch {
      return null;
    }
  }

  /**
   * All media messages of a conversation (photo / video / document /
   * voice), oldest first. Used by the admin leads page to show a
   * candidate's photos inline.
   */
  async mediaForConversation(conversationId: number): Promise<
    {
      id: number;
      type: string;
      file_id: string | null;
      file: string | null;
      photo_class: string | null;
      caption: string;
      created_at: number;
    }[]
  > {
    return this.sql<
      {
        id: number;
        type: string;
        file_id: string | null;
        file: string | null;
        photo_class: string | null;
        caption: string;
        created_at: number;
      }[]
    >`
      SELECT
        id,
        text AS caption,
        created_at,
        (meta_json::jsonb)->'media'->>'type' AS type,
        (meta_json::jsonb)->'media'->>'file_id' AS file_id,
        (meta_json::jsonb)->'media'->>'file' AS file,
        (meta_json::jsonb)->'media'->>'photo_class' AS photo_class
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND role = 'user'
        AND meta_json IS NOT NULL
        AND (meta_json::jsonb)->'media'->>'type' IS NOT NULL
      ORDER BY id ASC
    `;
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
      internal_passport: 0,
      full_body: 0,
      portrait: 0,
      other: 0,
    };
    for (const r of rows) {
      if (
        r.cls === "passport" ||
        r.cls === "internal_passport" ||
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
