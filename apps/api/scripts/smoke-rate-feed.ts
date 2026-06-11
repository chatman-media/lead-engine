#!/usr/bin/env bun
/**
 * Smoke-тест рыночного фида: тянет реальные курсы и проверяет, что auto-строки
 * обновляются. Требует сеть (open.er-api.com, Binance). НЕ для production.
 *
 *   DATABASE_URL=... bun run apps/api/scripts/smoke-rate-feed.ts
 *
 * Котируемая валюта берётся из EXCHANGE_QUOTE_ASSET (платформенный дефолт PHP):
 *   EXCHANGE_QUOTE_ASSET=THB DATABASE_URL=... bun run apps/api/scripts/smoke-rate-feed.ts
 */

import { QUOTE_CURRENCY, withTenant } from "@chatman-media/conversation-engine";
import { exchangeRates } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fetchMarketQuotePerUnit, refreshTenantRates } from "../src/lib/exchange/rate-feed.ts";

const TENANT = 3;
const QUOTE = QUOTE_CURRENCY.code;
const url = process.env.DATABASE_URL ?? "postgres://lead:lead@localhost:5434/lead_engine";
const client = postgres(url, { max: 1, prepare: false });
// biome-ignore lint/suspicious/noExplicitAny: smoke
const db = drizzle(client) as any;

async function main() {
  console.log(`=== рыночные курсы (${QUOTE} за 1 единицу) ===`);
  for (const a of ["USDT", "USD", "EUR", "RUB", "BTC", "ETH"]) {
    try {
      const v = await fetchMarketQuotePerUnit(a);
      console.log(`  ${a}: ${v}`);
    } catch (e) {
      console.log(`  ${a}: FAIL ${e instanceof Error ? e.message : e}`);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  await withTenant(db, TENANT, async (tx) => {
    for (const r of [
      { asset: "USDT", network: "trc20", quoteMode: "multiply" },
      { asset: "RUB", network: "", quoteMode: "divide" },
    ]) {
      await tx
        .insert(exchangeRates)
        .values({ tenantId: TENANT, asset: r.asset, quoteAsset: QUOTE, network: r.network, baseRate: 0, quoteMode: r.quoteMode, autoUpdate: true, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [exchangeRates.tenantId, exchangeRates.asset, exchangeRates.quoteAsset, exchangeRates.network],
          set: { baseRate: 0, autoUpdate: true, quoteMode: r.quoteMode, isActive: true, updatedAt: now },
        });
    }
  });

  console.log("\n=== refreshTenantRates ===");
  const res = await refreshTenantRates(db, TENANT, { warn: (m) => console.warn("  warn:", m) });
  console.log("  result:", res);

  const after = await withTenant(db, TENANT, async (tx) =>
    tx.select({ asset: exchangeRates.asset, baseRate: exchangeRates.baseRate, mode: exchangeRates.quoteMode })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.tenantId, TENANT), eq(exchangeRates.autoUpdate, true))),
  );
  console.log("  base_rate после фида:");
  let ok = true;
  for (const row of after) {
    console.log(`    ${row.asset} (${row.mode}): ${row.baseRate}`);
    if (!(Number(row.baseRate) > 0)) ok = false;
  }

  // cleanup
  await withTenant(db, TENANT, async (tx) => {
    await tx.delete(exchangeRates).where(and(eq(exchangeRates.tenantId, TENANT), eq(exchangeRates.quoteAsset, QUOTE)));
  });

  await client.end({ timeout: 0 });
  console.log(ok ? `\n✅ фид обновил base_rate (${QUOTE})` : "\n❌ base_rate не обновился (проверь сеть/API)");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
