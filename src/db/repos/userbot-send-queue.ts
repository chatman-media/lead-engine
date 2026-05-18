import type { Sql } from "../postgres.ts";

/** Cap on retry attempts before a row is parked permanently. Stops a
 *  permanently-broken peer (user blocked the userbot account) from
 *  re-queuing forever on every poll. */
export const MAX_SEND_ATTEMPTS = 5;

/**
 * Enqueue an outgoing admin reply for the userbot to send.
 *
 * `messageId` links the queue row to its `messages` row — after the userbot
 * sends the message it stamps the returned Telegram message id back onto that
 * row's `tg_message_id`, which is what a later "delete from Telegram" needs.
 */
export async function enqueue(
  sql: Sql,
  tgUserId: number,
  text: string,
  messageId?: number,
): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO userbot_send_queue (tg_user_id, text, message_id)
    VALUES (${tgUserId}, ${text}, ${messageId ?? null})
    RETURNING id
  `;
  return row.id;
}

/**
 * Atomically claim the next batch of pending rows for this poller.
 *
 * `FOR UPDATE SKIP LOCKED` inside the inner SELECT means a parallel
 * poller (second userbot replica, or a re-entrant drain on a slow
 * Telegram send) can't grab the same row. The outer UPDATE bumps
 * `attempts` so a row that keeps failing eventually crosses
 * `MAX_SEND_ATTEMPTS` and stops re-appearing.
 */
export async function dequeuePending(
  sql: Sql,
): Promise<
  { id: number; tg_user_id: number; text: string; attempts: number; message_id: number | null }[]
> {
  return sql<
    { id: number; tg_user_id: number; text: string; attempts: number; message_id: number | null }[]
  >`
    UPDATE userbot_send_queue
    SET attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM userbot_send_queue
      WHERE sent_at IS NULL
        AND attempts < ${MAX_SEND_ATTEMPTS}
      ORDER BY id
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tg_user_id, text, attempts, message_id
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
