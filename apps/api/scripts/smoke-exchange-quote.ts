#!/usr/bin/env bun
/**
 * Smoke-тест движка котировок: сверяет computeQuote с тремя реальными
 * сценариями ARBI Exchange. НЕ для production. Использует dev-БД.
 *
 *   DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
 *   bun run apps/api/scripts/smoke-exchange-quote.ts
 */

import { withTenant } from "@chatman-media/conversation-engine";
import { exchangeRates } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { computeQuote } from "../src/lib/exchange/rates.ts";

const TENANT = 3; // bob-2beb6f
const url = process.env.DATABASE_URL ?? "postgres://lead:lead@localhost:5434/lead_engine";
const client = postgres(url, { max: 1, prepare: false });
const db = drizzle(client) as unknown as Parameters<typeof computeQuote>[0];

async function upsertRate(r: {
  asset: string;
  network: string;
  baseRate: number;
  quoteMode: "multiply" | "divide";
  marginPct?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  await withTenant(db as never, TENANT, async (tx) => {
    await tx
      .insert(exchangeRates)
      .values({
        tenantId: TENANT,
        asset: r.asset,
        quoteAsset: "THB",
        network: r.network,
        baseRate: r.baseRate,
        quoteMode: r.quoteMode,
        marginPct: r.marginPct ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          exchangeRates.tenantId,
          exchangeRates.asset,
          exchangeRates.quoteAsset,
          exchangeRates.network,
        ],
        set: {
          baseRate: r.baseRate,
          quoteMode: r.quoteMode,
          marginPct: r.marginPct ?? 0,
          isActive: true,
          updatedAt: now,
        },
      });
  });
}

function assertEq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  console.log(`${ok ? "✅" : "❌"} ${label}: got=${got} want=${want}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  // Курсы как в реальных переписках.
  await upsertRate({ asset: "USDT", network: "trc20", baseRate: 31.0448, quoteMode: "multiply" });
  await upsertRate({ asset: "RUB", network: "", baseRate: 3.1, quoteMode: "divide" });

  // Сценарий 2: 335 USDT → 10400 THB
  const q1 = await computeQuote(db as never, TENANT, { asset: "USDT", amount: 335 });
  assertEq("USDT 335 → THB", q1.ok && q1.amountToThb, 10400);
  assertEq("USDT 335 rate", q1.ok && q1.rate, 31.0448);
  assertEq("USDT 335 direction", q1.ok && q1.direction, "USDT->THB");
  assertEq("USDT default network", q1.ok && q1.network, "TRC20");

  // Сценарий 1: 3100 RUB → 1000 THB (divide @ 3.1)
  const q2 = await computeQuote(db as never, TENANT, { asset: "RUB", amount: 3100 });
  assertEq("RUB 3100 → THB", q2.ok && q2.amountToThb, 1000);
  assertEq("RUB 3100 rate", q2.ok && q2.rate, 3.1);

  // Сценарий 3: 90 USDT @ 28.888889 → 2600 THB (отдельный курс)
  await upsertRate({ asset: "USDT", network: "trc20", baseRate: 28.888889, quoteMode: "multiply" });
  const q3 = await computeQuote(db as never, TENANT, { asset: "USDT", amount: 90 });
  assertEq("USDT 90 → THB", q3.ok && q3.amountToThb, 2600);

  // Маржа: base 31.0448, маржа 2% → eff = 30.4239, 100 USDT → 3042 THB
  await upsertRate({
    asset: "USDT",
    network: "trc20",
    baseRate: 31.0448,
    quoteMode: "multiply",
    marginPct: 2,
  });
  const q4 = await computeQuote(db as never, TENANT, { asset: "USDT", amount: 100 });
  assertEq("USDT 100 @2% margin → THB", q4.ok && q4.amountToThb, Math.round(100 * 31.0448 * 0.98));

  // Нет курса → ошибка
  const q5 = await computeQuote(db as never, TENANT, { asset: "BTC", amount: 1 });
  assertEq("BTC no rate → error", q5.ok, false);

  // Очистка тестовых курсов
  await withTenant(db as never, TENANT, async (tx) => {
    await tx
      .delete(exchangeRates)
      .where(and(eq(exchangeRates.tenantId, TENANT), eq(exchangeRates.quoteAsset, "THB")));
  });

  await client.end({ timeout: 0 });
  console.log(process.exitCode ? "\nFAILED" : "\nALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
