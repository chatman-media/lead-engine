import type { Sql } from "../postgres.ts";

export async function enqueue(sql: Sql, tgUserId: number, text: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO userbot_send_queue (tg_user_id, text)
    VALUES (${tgUserId}, ${text})
    RETURNING id
  `;
  return row.id;
}

export async function dequeuePending(
  sql: Sql,
): Promise<{ id: number; tg_user_id: number; text: string }[]> {
  // Retry all unsent messages regardless of previous errors — transient
  // gramJS failures (entity cache miss, TIMEOUT) should resolve on next poll.
  return sql<{ id: number; tg_user_id: number; text: string }[]>`
    SELECT id, tg_user_id, text
    FROM userbot_send_queue
    WHERE sent_at IS NULL
    ORDER BY id
    LIMIT 50
  `;
}

export async function markSent(sql: Sql, id: number): Promise<void> {
  await sql`
    UPDATE userbot_send_queue
    SET sent_at = EXTRACT(EPOCH FROM NOW())::INTEGER
    WHERE id = ${id}
  `;
}

export async function markFailed(sql: Sql, id: number, error: string): Promise<void> {
  await sql`
    UPDATE userbot_send_queue
    SET error = ${error}
    WHERE id = ${id}
  `;
}
