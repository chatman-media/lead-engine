#!/usr/bin/env bun
import { config } from "../src/config.ts";
import { TelegramClient } from "../src/telegram/client.ts";

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--delete") args.delete = true;
    else if (a === "--info") args.info = true;
    else if (a === "--drop-pending") args.dropPending = true;
    else if (a.startsWith("--url=")) args.url = a.slice("--url=".length);
    else if (a === "--url") args.url = argv[++i] ?? "";
  }
  return args;
}

async function main() {
  if (!config.telegram.botToken) {
    console.error("TELEGRAM_BOT_TOKEN is not set in env.");
    process.exit(1);
  }
  const client = new TelegramClient({ token: config.telegram.botToken });
  const args = parseArgs(process.argv.slice(2));

  if (args.delete) {
    await client.deleteWebhook(Boolean(args.dropPending));
    console.log("Webhook deleted.");
    return;
  }

  if (args.info) {
    const info = await client.getWebhookInfo();
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  const baseUrl =
    typeof args.url === "string" && args.url
      ? args.url
      : config.publicBaseUrl;
  if (!baseUrl || baseUrl.startsWith("http://localhost")) {
    console.error(
      "Webhook URL must be a public HTTPS URL. Pass --url=https://your.host or set PUBLIC_BASE_URL.",
    );
    process.exit(1);
  }
  const fullUrl = `${baseUrl.replace(/\/+$/, "")}/telegram/${config.telegram.webhookSecret}`;
  await client.setWebhook({
    url: fullUrl,
    secretToken: config.telegram.webhookSecret,
    allowedUpdates: ["message", "callback_query"],
    dropPendingUpdates: Boolean(args.dropPending),
  });
  console.log(`Webhook set to ${fullUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
