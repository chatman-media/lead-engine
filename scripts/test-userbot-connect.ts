/**
 * Minimal gramJS connection test — no DB, no RAG, no server.
 * Run: bun scripts/test-userbot-connect.ts
 * Needs: TELEGRAM_API_ID, TELEGRAM_API_HASH, USERBOT_SESSION in .env
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? "";
const sessionStr = process.env.USERBOT_SESSION ?? "";

if (!apiId || !apiHash || !sessionStr) {
  console.error("Need TELEGRAM_API_ID, TELEGRAM_API_HASH, USERBOT_SESSION in .env");
  process.exit(1);
}

console.log("Connecting to Telegram MTProto...");
const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
  connectionRetries: 3,
  retryDelay: 2000,
  timeout: 30,
});

const t0 = Date.now();
try {
  await client.connect();
  console.log(`Connected in ${Date.now() - t0}ms`);
  const me = await client.getMe();
  console.log(
    "Authenticated as:",
    JSON.stringify({
      id: (me as any).id?.toString(),
      username: (me as any).username,
      firstName: (me as any).firstName,
    }),
  );
  await client.disconnect();
  console.log("Done — gramJS works fine locally ✓");
} catch (err) {
  console.error(`Failed after ${Date.now() - t0}ms:`, (err as Error).message);
  process.exit(1);
}
