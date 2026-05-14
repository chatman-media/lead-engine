/**
 * One-time script to authenticate a personal Telegram account for userbot mode.
 * Run once: bun scripts/userbot-auth.ts
 *
 * Requires: TELEGRAM_API_ID, TELEGRAM_API_HASH, DB_PATH in .env
 */

import * as readline from "node:readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { config } from "../src/config.ts";
import { sql } from "../src/db/postgres.ts";
import { saveUserbotSession } from "../src/db/repos/userbot-session.ts";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const { apiId, apiHash } = config.userbot;
  if (!apiId || !apiHash) {
    console.error(
      "Error: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env\n" +
        "Get them at https://my.telegram.org",
    );
    process.exit(1);
  }

  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log("Starting Telegram authentication...\n");

  await client.start({
    phoneNumber: async () => ask("Phone number (e.g. +79001234567): "),
    phoneCode: async () => ask("Code from Telegram: "),
    password: async () => ask("2FA password (press Enter to skip): "),
    onError: (err) => {
      console.error("Auth error:", err.message);
    },
  });

  const sessionString = client.session.save() as unknown as string;
  await saveUserbotSession(sql, sessionString);

  const me = await client.getMe();
  const username = (me as { username?: string }).username;
  const firstName = (me as { firstName?: string }).firstName;
  console.log(`\nAuthenticated as: ${firstName ?? ""}${username ? ` (@${username})` : ""}`);
  console.log("Session saved to database. You can now start the server with TELEGRAM_USERBOT=1.");

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
