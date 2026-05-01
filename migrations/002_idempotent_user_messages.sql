-- Telegram Bot API guarantees at-least-once webhook delivery: if our
-- handler doesn't reply 2xx within ~60s, Telegram retries the same
-- update_id with the same message_id. Before this migration we had no
-- defence against that — every retry inserted another row, polluting
-- the dialog history with phantom duplicates that the admin UI then
-- showed (one extra "user said X" per minute, looking like a bug).
--
-- Step 1: collapse any pre-existing duplicates we already accumulated.
--          Keep the earliest row (MIN(id)) per (conversation_id,
--          tg_message_id) for role='user'.
DELETE FROM messages
WHERE role = 'user'
  AND tg_message_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM messages
    WHERE role = 'user' AND tg_message_id IS NOT NULL
    GROUP BY conversation_id, tg_message_id
  );

-- Step 2: enforce idempotency at the DB level. Partial UNIQUE so we
--          don't constrain assistant/human/system rows (which legitimately
--          may carry the same tg_message_id only by coincidence — they
--          come from /sendMessage results, not from inbound updates).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_msg_user_tg
  ON messages(conversation_id, tg_message_id)
  WHERE role = 'user' AND tg_message_id IS NOT NULL;
