#!/usr/bin/env bun
/**
 * Minimal userbot send-queue drainer.
 * Connects gramJS, sends all pending admin replies, disconnects — repeating
 * every 5 seconds. Avoids the gramJS update-loop TIMEOUT entirely by
 * disconnecting before the 10-second internal deadline fires.
 *
 * Run: bun scripts/drain-queue.ts
 * Needs: TELEGRAM_API_ID, TELEGRAM_API_HASH, USERBOT_SESSION, DATABASE_URL
 */

import postgres from "postgres";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? "";
const sessionStr = process.env.USERBOT_SESSION ?? "";
const dbUrl = process.env.DATABASE_URL ?? "";

if (!apiId || !apiHash || !sessionStr || !dbUrl) {
  console.error("Need TELEGRAM_API_ID, TELEGRAM_API_HASH, USERBOT_SESSION, DATABASE_URL in .env");
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 3 });

async function drainOnce(): Promise<number> {
  const pending = await sql<{ id: number; tg_user_id: string; text: string }[]>`
    SELECT id, tg_user_id, text
    FROM userbot_send_queue
    WHERE sent_at IS NULL
    ORDER BY id
    LIMIT 50
  `;
  if (pending.length === 0) return 0;

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 3,
    retryDelay: 1000,
  });

  try {
    await client.connect();
  } catch (err) {
    console.error("[drain] connect failed:", (err as Error).message);
    return 0;
  }

  let sent = 0;
  for (const row of pending) {
    try {
      const tgUserId = Number(row.tg_user_id);
      let peer: Awaited<ReturnType<typeof client.getInputEntity>>;
      try {
        peer = await client.getInputEntity(tgUserId);
      } catch {
        // Fallback: try by @username from DB
        const [u] = await sql<{ tg_username: string | null }[]>`
          SELECT tg_username FROM users WHERE tg_user_id = ${tgUserId} LIMIT 1
        `;
        if (!u?.tg_username) {
          throw new Error(`No entity for tg_user_id=${tgUserId} and no username in DB`);
        }
        peer = await client.getInputEntity(`@${u.tg_username}`);
      }
      await client.sendMessage(peer, { message: row.text });
      await sql`
        UPDATE userbot_send_queue
        SET sent_at = EXTRACT(EPOCH FROM NOW())::INTEGER
        WHERE id = ${row.id}
      `;
      console.log(`[drain] sent id=${row.id} → tg_user_id=${row.tg_user_id}`);
      sent++;
    } catch (err) {
      console.error(`[drain] failed id=${row.id}:`, (err as Error).message);
      await sql`
        UPDATE userbot_send_queue SET error = ${(err as Error).message} WHERE id = ${row.id}
      `.catch(() => {});
    }
  }

  // Disconnect BEFORE the 10s update-loop TIMEOUT fires
  await client.disconnect().catch(() => {});
  return sent;
}

console.log("[drain] started — polling queue every 5s");

let iteration = 0;
while (true) {
  iteration++;
  try {
    const n = await drainOnce();
    if (n > 0) console.log(`[drain] cycle #${iteration}: sent ${n} message(s)`);
  } catch (err) {
    console.error(`[drain] cycle #${iteration} error:`, (err as Error).message);
  }
  await Bun.sleep(5000);
}
