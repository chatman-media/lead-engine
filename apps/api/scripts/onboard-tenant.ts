#!/usr/bin/env bun
/**
 * Onboarding-скрипт для нового tenant'а. Создаёт:
 *   - tenants row (slug, plan='free', llm_billing_mode='byok')
 *   - tenant_secrets с зашифрованным bot_token
 *   - channels row (telegram_bot kind, credentials_ref → tenant_secrets.key)
 *   - funnels row с vertical_template_id (если задан)
 *
 * Usage:
 *   bun run apps/api/scripts/onboard-tenant.ts \
 *     --slug=studio-alpha --bot-token=123:ABC --vertical=recruitment_uae_v1
 *
 * Env:
 *   DATABASE_URL — Postgres URL
 *   PLATFORM_MASTER_KEY — 64 hex chars (32 bytes) для AES-256-GCM
 */

import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import { channels, funnels, tenants } from "@chatman-media/storage";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

interface Args {
  slug: string;
  botToken: string;
  vertical: string | null;
  botUsername: string | null;
}

function parseArgs(): Args {
  const out: Partial<Args> = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (!k || v === undefined) continue;
    if (k === "slug") out.slug = v;
    else if (k === "bot-token") out.botToken = v;
    else if (k === "vertical") out.vertical = v;
    else if (k === "bot-username") out.botUsername = v;
  }
  if (!out.slug) throw new Error("--slug required");
  if (!out.botToken) throw new Error("--bot-token required");
  return {
    slug: out.slug,
    botToken: out.botToken,
    vertical: out.vertical ?? null,
    botUsername: out.botUsername ?? null,
  };
}

async function main() {
  const args = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  const masterKeyHex = process.env.PLATFORM_MASTER_KEY;
  if (!databaseUrl) throw new Error("DATABASE_URL env required");
  if (!masterKeyHex) throw new Error("PLATFORM_MASTER_KEY env required");

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

    // 2. encrypted bot-token в tenant_secrets под key='telegram_bot_token'.
    await setEncryptedSecret({
      db,
      tenantId: tenant.id,
      key: "telegram_bot_token",
      value: args.botToken,
      masterKeyHex,
      nowEpoch: now,
    });
    console.log("[onboard] bot token encrypted and stored");

    // 3. channel telegram_bot.
    const [channel] = await db
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
    if (!channel) throw new Error("channel insert failed");
    console.log(`[onboard] channel created id=${channel.id}`);

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
    console.log(`  - webhook URL suffix: /webhook/telegram/${tenant.slug}`);
    console.log(
      `  - set Telegram webhook: curl -X POST ` +
        `"https://api.telegram.org/bot${args.botToken}/setWebhook" ` +
        `-d "url=<HOST>/webhook/telegram/${tenant.slug}&secret_token=<TELEGRAM_WEBHOOK_SECRET>"`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[onboard] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
