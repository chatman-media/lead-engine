import type { Sql } from "../postgres.ts";

/** Cap on retry attempts before a delete row is parked permanently — stops a
 *  permanently-undeletable message (already gone, peer unresolvable) from
 *  re-queuing forever on every poll. */
export const MAX_DELETE_ATTEMPTS = 5;

/** Enqueue a sent Telegram message for the userbot to delete. */
export async function enqueueDelete(
  sql: Sql,
  tgUserId: number,
  tgMessageId: number,
): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO userbot_delete_queue (tg_user_id, tg_message_id)
    VALUES (${tgUserId}, ${tgMessageId})
    RETURNING id
  `;
  return row.id;
}

/**
 * Atomically claim the next batch of pending delete rows for this poller.
 * Mirrors `userbot_send_queue.dequeuePending` — `FOR UPDATE SKIP LOCKED`
 * keeps a parallel drain from grabbing the same row, the outer UPDATE bumps
 * `attempts` so a row that keeps failing eventually stops re-appearing.
 */
export async function dequeuePendingDeletes(
  sql: Sql,
): Promise<{ id: number; tg_user_id: number; tg_message_id: number; attempts: number }[]> {
  return sql<{ id: number; tg_user_id: number; tg_message_id: number; attempts: number }[]>`
    UPDATE userbot_delete_queue
    SET attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM userbot_delete_queue
      WHERE done_at IS NULL
        AND attempts < ${MAX_DELETE_ATTEMPTS}
      ORDER BY id
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tg_user_id, tg_message_id, attempts
  `;
}

export async function markDeleted(sql: Sql, id: number): Promise<void> {
  await sql`
    UPDATE userbot_delete_queue
    SET done_at = EXTRACT(EPOCH FROM NOW())::INTEGER
    WHERE id = ${id}
  `;
}

export async function markDeleteFailed(sql: Sql, id: number, error: string): Promise<void> {
  await sql`
    UPDATE userbot_delete_queue
    SET error = ${error}
    WHERE id = ${id}
  `;
}
