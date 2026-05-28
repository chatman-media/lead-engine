#!/usr/bin/env bun
/**
 * Smoke-тест полного tool-flow обменника против dev-БД:
 *   compute_exchange_quote → create_exchange_order (идемпотентно) →
 *   fetch_exchange_requisites → verify_exchange_payment → issue_exchange_payout.
 * Создаёт временный contact+conversation, в конце чистит exchange-данные.
 *
 *   DATABASE_URL=... PLATFORM_MASTER_KEY=<64hex> bun run apps/api/scripts/smoke-exchange-flow.ts
 */

import { withTenant } from "@chatman-media/conversation-engine";
import { contacts, conversations, exchangeOrders, exchangeRates } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { makeExchangeTools } from "../src/lib/exchange/tools.ts";

const TENANT = 3;
const MASTER = process.env.PLATFORM_MASTER_KEY ?? "0".repeat(64);
const url = process.env.DATABASE_URL ?? "postgres://lead:lead@localhost:5434/lead_engine";
const client = postgres(url, { max: 1, prepare: false });
// biome-ignore lint/suspicious/noExplicitAny: smoke test
const db = drizzle(client) as any;

let pass = true;
function check(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "✅" : "❌"} ${label}`, extra ?? "");
  if (!cond) pass = false;
}

async function main() {
  // seed rate
  const now = Math.floor(Date.now() / 1000);
  await withTenant(db, TENANT, async (tx) => {
    await tx
      .insert(exchangeRates)
      .values({ tenantId: TENANT, asset: "USDT", quoteAsset: "THB", network: "trc20", baseRate: 31.0448, quoteMode: "multiply", createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [exchangeRates.tenantId, exchangeRates.asset, exchangeRates.quoteAsset, exchangeRates.network],
        set: { baseRate: 31.0448, isActive: true, updatedAt: now },
      });
  });

  // temp contact + conversation
  const convId = await withTenant(db, TENANT, async (tx) => {
    const [ct] = await tx
      .insert(contacts)
      .values({ tenantId: TENANT, displayName: "SMOKE Exchange", createdAt: now, updatedAt: now })
      .returning({ id: contacts.id });
    const [cv] = await tx
      .insert(conversations)
      .values({ tenantId: TENANT, userId: ct!.id, source: "self_play", createdAt: now })
      .returning({ id: conversations.id });
    return cv!.id;
  });

  const tools = makeExchangeTools({ db, tenantId: TENANT, conversationId: convId, masterKeyHex: MASTER });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  // 1. quote
  const q = (await byName.compute_exchange_quote!.execute({ asset: "USDT", amount: 335 })) as Record<string, unknown>;
  check("quote 335 USDT → 10400 THB", q.amountToThb === 10400, q.display);

  // 2. create order
  const o1 = (await byName.create_exchange_order!.execute({ asset: "USDT", amount: 335, payoutMethod: "office" })) as Record<string, unknown>;
  check("order created (awaiting_payment)", o1.status === "awaiting_payment", o1);
  const orderId = o1.orderId;

  // 2b. idempotent re-call → same order
  const o2 = (await byName.create_exchange_order!.execute({ asset: "USDT", amount: 335 })) as Record<string, unknown>;
  check("createOrder idempotent (same id)", o2.orderId === orderId && o2.idempotent === true, o2);

  // 3. requisites (no wallet configured → needsOperator)
  const r = (await byName.fetch_exchange_requisites!.execute({})) as Record<string, unknown>;
  check("requisites needsOperator (no wallet)", r.needsOperator === true, r);

  // 4. verify without txhash → asks for hash
  const v = (await byName.verify_exchange_payment!.execute({})) as Record<string, unknown>;
  check("verify w/o proof → not ok", v.ok === false, v);

  // 5. payout before paid → blocked
  const p = (await byName.issue_exchange_payout!.execute({ payoutMethod: "office", location: "Бангтао" })) as Record<string, unknown>;
  check("payout blocked before paid", typeof p.error === "string", p);

  // cleanup
  await withTenant(db, TENANT, async (tx) => {
    await tx.delete(exchangeOrders).where(and(eq(exchangeOrders.tenantId, TENANT), eq(exchangeOrders.conversationId, convId)));
    await tx.delete(conversations).where(and(eq(conversations.tenantId, TENANT), eq(conversations.id, convId)));
    await tx.delete(exchangeRates).where(and(eq(exchangeRates.tenantId, TENANT), eq(exchangeRates.asset, "USDT")));
  });

  await client.end({ timeout: 0 });
  console.log(pass ? "\nALL PASS" : "\nFAILED");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
