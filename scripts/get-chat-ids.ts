/**
 * Lists all group/channel chats with their IDs.
 * Run: bun scripts/get-chat-ids.ts
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { config } from "../src/config.ts";
import { loadUserbotSession } from "../src/db/repos/userbot-session.ts";
import { getDb } from "../src/db/sqlite.ts";

const db = getDb();
const sessionString = loadUserbotSession(db);

if (!sessionString) {
  console.error("No saved session. Run `bun scripts/userbot-auth.ts` first.");
  process.exit(1);
}

const client = new TelegramClient(
  new StringSession(sessionString),
  config.userbot.apiId,
  config.userbot.apiHash,
  {
    connectionRetries: 3,
  },
);

await client.connect();

const dialogs = await client.getDialogs({ limit: 100 });

console.log("\n=== Ваши чаты ===\n");
for (const dialog of dialogs) {
  const entity = dialog.entity;
  if (!entity) continue;

  const type = "className" in entity ? entity.className : "Unknown";
  if (type !== "Chat" && type !== "Channel") continue;

  const id = "id" in entity ? entity.id : null;
  if (!id) continue;

  // Telegram group/channel IDs in Bot API format are prefixed with -100
  const botApiId = type === "Channel" ? Number(`-100${id}`) : -Number(id);

  console.log(`${dialog.title}`);
  console.log(`  ID для .env: ${botApiId}`);
  console.log();
}

await client.disconnect();
