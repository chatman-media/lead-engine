#!/usr/bin/env bun
/**
 * Onboarding-скрипт для нового tenant'а. Создаёт:
 *   - tenants row (slug, plan='free', llm_billing_mode='byok')
 *   - tenant_secrets с зашифрованным bot_token (если --bot-token задан)
 *   - channels row для telegram_bot и/или web
 *   - funnels row с vertical_template_id (если задан)
 *
 * Usage:
 *   # Telegram-only
 *   bun run apps/api/scripts/onboard-tenant.ts \
 *     --slug=studio-alpha --bot-token=123:ABC --vertical=recruitment_uae_v1
 *
 *   # Web-only (для embedded chat-widget'а)
 *   bun run apps/api/scripts/onboard-tenant.ts \
 *     --slug=acme --with-web
 *
 *   # Multi-channel (и Telegram, и web)
 *   bun run apps/api/scripts/onboard-tenant.ts \
 *     --slug=acme --bot-token=123:ABC --with-web
 *
 * Env:
 *   DATABASE_URL — Postgres URL
 *   PLATFORM_MASTER_KEY — 64 hex chars (32 bytes) для AES-256-GCM
 *                         (required если --bot-token задан)
 */

import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import { channels, funnels, tenants } from "@chatman-media/storage";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

interface Args {
  slug: string;
  botToken: string | null;
  vertical: string | null;
  botUsername: string | null;
  withWeb: boolean;
}

function parseArgs(): Args {
  const out: Partial<Args> = { withWeb: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--with-web") {
      out.withWeb = true;
      continue;
    }
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (!k || v === undefined) continue;
    if (k === "slug") out.slug = v;
    else if (k === "bot-token") out.botToken = v;
    else if (k === "vertical") out.vertical = v;
    else if (k === "bot-username") out.botUsername = v;
  }
  if (!out.slug) throw new Error("--slug required");
  if (!out.botToken && !out.withWeb) {
    throw new Error("at least one channel required: --bot-token and/or --with-web");
  }
  return {
    slug: out.slug,
    botToken: out.botToken ?? null,
    vertical: out.vertical ?? null,
    botUsername: out.botUsername ?? null,
    withWeb: out.withWeb ?? false,
  };
}

async function main() {
  const args = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  const masterKeyHex = process.env.PLATFORM_MASTER_KEY;
  if (!databaseUrl) throw new Error("DATABASE_URL env required");
  // PLATFORM_MASTER_KEY нужен только для bot-token'а (AES-256-GCM).
  // Web-only onboarding обходится без него.
  if (args.botToken && !masterKeyHex) {
    throw new Error("PLATFORM_MASTER_KEY env required when --bot-token задан");
  }

  const client = postgres(databaseUrl, { max: 2 });
  const db = drizzle(client);
  const now = Math.floor(Date.now() / 1000);

  try {
    // 1. tenant. ON CONFLICT не на slug-only — мы не хотим случайно
    // переписать existing tenant. Падаем если slug занят.
    const [tenant] = await db
      .insert(tenants)
      .values({
        slug: args.slug,
        plan: "free",
        status: "active",
        llmBillingMode: "byok",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!tenant) throw new Error("tenant insert returned no row");
    console.log(`[onboard] tenant created id=${tenant.id} slug=${tenant.slug}`);

    // 2. Telegram-channel (если bot-token задан).
    let telegramChannel: { id: number } | null = null;
    if (args.botToken) {
      // 2a. encrypted bot-token → tenant_secrets под key='telegram_bot_token'.
      await setEncryptedSecret({
        db,
        tenantId: tenant.id,
        key: "telegram_bot_token",
        value: args.botToken,
        // masterKeyHex existence уже валидирован в main().
        // biome-ignore lint/style/noNonNullAssertion: гарантирован проверкой выше
        masterKeyHex: masterKeyHex!,
        nowEpoch: now,
      });
      console.log("[onboard] bot token encrypted and stored");

      const [ch] = await db
        .insert(channels)
        .values({
          tenantId: tenant.id,
          kind: "telegram_bot",
          externalId: args.botUsername ?? `${args.slug}-bot`,
          credentialsRef: "telegram_bot_token",
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!ch) throw new Error("telegram_bot channel insert failed");
      telegramChannel = ch;
      console.log(`[onboard] telegram_bot channel created id=${ch.id}`);
    }

    // 3. Web-channel (если --with-web).
    let webChannel: { id: number } | null = null;
    if (args.withWeb) {
      const [ch] = await db
        .insert(channels)
        .values({
          tenantId: tenant.id,
          kind: "web",
          // external_id у web — slug канала. Pilot: один web-канал на
          // tenant'а, поэтому используем сам tenant slug. Когда появится
          // multi-widget на одного клиента — расщепить (например,
          // `<tenant>-main`, `<tenant>-checkout`).
          externalId: args.slug,
          // credentials_ref у web не используется — auth через
          // WEB_WS_AUTH_SECRET (platform-wide) на текущем этапе.
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!ch) throw new Error("web channel insert failed");
      webChannel = ch;
      console.log(`[onboard] web channel created id=${ch.id}`);
    }

    // 4. funnel (опционально — только если задана vertical).
    if (args.vertical) {
      const [funnel] = await db
        .insert(funnels)
        .values({
          tenantId: tenant.id,
          slug: "default",
          verticalTemplateId: args.vertical,
          stagesJson: "[]",
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (funnel) {
        console.log(`[onboard] funnel created id=${funnel.id} vertical=${args.vertical}`);
      }
    }

    console.log("[onboard] done. Tenant ready:");
    console.log(`  - tenant_id: ${tenant.id}`);
    console.log(`  - slug: ${tenant.slug}`);
    if (telegramChannel) {
      console.log(`  - telegram channel id: ${telegramChannel.id}`);
      console.log(`  - webhook URL suffix: /webhook/telegram/${tenant.slug}`);
      console.log(
        `  - set Telegram webhook: curl -X POST ` +
          `"https://api.telegram.org/bot${args.botToken}/setWebhook" ` +
          `-d "url=<HOST>/webhook/telegram/${tenant.slug}&secret_token=<TELEGRAM_WEBHOOK_SECRET>"`,
      );
    }
    if (webChannel) {
      console.log(`  - web channel id: ${webChannel.id}`);
      console.log(
        `  - WebSocket URL: ws://<HOST>/ws/${tenant.slug}?user=<USER_ID>[&auth=<WEB_WS_AUTH_SECRET>]`,
      );
      console.log("  - Open apps/api/demo/web-chat.html в браузере для smoke-теста");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[onboard] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
