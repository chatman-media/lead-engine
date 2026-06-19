#!/usr/bin/env bun

/**
 * Seed demo payout points for TH and PH exchange tenants.
 *
 * Seeds ATM, office, and courier_zone points with realistic
 * denomination/perWithdrawalMax/codeTtlSec values for cardless withdrawal.
 *
 * Usage:
 *   DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
 *   TENANT_SLUG=phdemo \
 *   bun run --cwd apps/api scripts/seed-payout-points.ts
 *
 * Optional:
 *   KEEP_EXISTING=1  -- skip if code already exists (default: upsert)
 */

import { resolve } from "node:path";
import {
  applyAllMigrations,
  createIsolatedDb,
  exchangePayoutPoints,
  schema,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const ownerUrl = process.env.DATABASE_URL;
if (!ownerUrl) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
const tenantSlug = process.env.TENANT_SLUG ?? "phdemo";
const keepExisting = process.env.KEEP_EXISTING === "1";

const sql = postgres(ownerUrl, { max: 2, onnotice: () => {} });
const db = drizzle(sql, { schema });

// ── Thai Baht ATMs (SCB, Kasikorn, BBL) ─────────────────────────────────────
const THB_POINTS = [
  {
    kind: "atm" as const,
    code: "scb_asok",
    label: "SCB Asok BTS",
    bankName: "SCB",
    quoteAsset: "THB",
    denomination: 500,
    perWithdrawalMax: 20_000,
    codeTtlSec: 900,
    city: "Bangkok",
    address: "Sukhumvit Soi 21 (Asok BTS)",
    feeFixed: 0,
    feePct: 0,
    isActive: true,
  },
  {
    kind: "atm" as const,
    code: "kbank_prom",
    label: "Kasikorn Phrom Phong",
    bankName: "KBANK",
    quoteAsset: "THB",
    denomination: 1000,
    perWithdrawalMax: 20_000,
    codeTtlSec: 900,
    city: "Bangkok",
    address: "Sukhumvit Soi 39 (Phrom Phong)",
    feeFixed: 0,
    feePct: 0,
    isActive: true,
  },
  {
    kind: "atm" as const,
    code: "bbl_silom",
    label: "Bangkok Bank Silom",
    bankName: "BBL",
    quoteAsset: "THB",
    denomination: 500,
    perWithdrawalMax: 20_000,
    codeTtlSec: 900,
    city: "Bangkok",
    address: "Silom Road",
    feeFixed: 0,
    feePct: 0,
    isActive: true,
  },
  {
    kind: "office" as const,
    code: "office_bkk_sukhumvit",
    label: "Офис Сукхумвит",
    bankName: null,
    quoteAsset: "THB",
    denomination: null,
    perWithdrawalMax: null,
    codeTtlSec: null,
    city: "Bangkok",
    address: "Sukhumvit Soi 11",
    feeFixed: 0,
    feePct: 0,
    isActive: true,
  },
  {
    kind: "courier_zone" as const,
    code: "courier_bkk_central",
    label: "Доставка — центр Бангкока",
    bankName: null,
    quoteAsset: "THB",
    denomination: null,
    perWithdrawalMax: null,
    codeTtlSec: null,
    city: "Bangkok",
    address: null,
    feeFixed: 300,
    feePct: 0,
    isActive: true,
  },
];

// ── Philippine Peso ATMs (BDO, BPI, Metrobank, GCash) ───────────────────────
const PHP_POINTS = [
  {
    kind: "atm" as const,
    code: "bdo_makati",
    label: "BDO Ayala Makati",
    bankName: "BDO",
    quoteAsset: "PHP",
    denomination: 100,
    perWithdrawalMax: 10_000,
    codeTtlSec: 1800,
    city: "Makati",
    address: "Ayala Avenue",
    feeFixed: 0,
    feePct: 0,
    isActive: true,
  },
  {
    kind: "atm" as const,
    code: "bpi_bgc",
    label: "BPI Bonifacio Global City",
    bankName: "BPI",
    quoteAsset: "PHP",
    denomination: 100,
    perWithdrawalMax: 10_000,
    codeTtlSec: 1800,
    city: "Taguig",
    address: "BGC High Street",
    feeFixed: 0,
    feePct: 0,
    isActive: true,
  },
  {
    kind: "atm" as const,
    code: "metrobank_ortigas",
    label: "Metrobank Ortigas",
    bankName: "Metrobank",
    quoteAsset: "PHP",
    denomination: 100,
    perWithdrawalMax: 10_000,
    codeTtlSec: 1800,
    city: "Pasig",
    address: "Ortigas Center",
    feeFixed: 0,
    feePct: 0,
    isActive: true,
  },
  {
    kind: "atm" as const,
    code: "gcash_makati",
    label: "GCash партнёрский кассир (Makati)",
    bankName: "GCash",
    quoteAsset: "PHP",
    denomination: 100,
    perWithdrawalMax: 5_000,
    codeTtlSec: 900,
    city: "Makati",
    address: null,
    feeFixed: 0,
    feePct: 0,
    isActive: true,
  },
  {
    kind: "office" as const,
    code: "office_manila_makati",
    label: "Офис Макати",
    bankName: null,
    quoteAsset: "PHP",
    denomination: null,
    perWithdrawalMax: null,
    codeTtlSec: null,
    city: "Makati",
    address: "Ayala Triangle",
    feeFixed: 0,
    feePct: 0,
    isActive: true,
  },
];

async function run() {
  // Resolve tenant id by slug (no RLS bypass needed — superuser query)
  const [tenant] = await sql<{ id: number }[]>`
    SELECT id FROM tenants WHERE slug = ${tenantSlug} LIMIT 1
  `;
  if (!tenant) {
    console.error(`Tenant "${tenantSlug}" not found. Create it first (seed-exchange-demo).`);
    await sql.end({ timeout: 0 });
    process.exit(1);
  }
  const tenantId = tenant.id;
  console.log(`Seeding payout points for tenant #${tenantId} (${tenantSlug})`);

  const quoteAsset = tenantSlug === "phdemo" || tenantSlug.includes("ph") ? "PHP" : "THB";
  const points = quoteAsset === "PHP" ? PHP_POINTS : THB_POINTS;

  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  let skipped = 0;

  for (const p of points) {
    const [existing] = await sql<{ id: number }[]>`
      SELECT id FROM exchange_payout_points
      WHERE tenant_id = ${tenantId} AND code = ${p.code}
      LIMIT 1
    `;
    if (existing) {
      if (keepExisting) {
        console.log(`  skip  ${p.code} (exists)`);
        skipped++;
        continue;
      }
      // Upsert: update existing
      await sql`
        UPDATE exchange_payout_points
        SET label = ${p.label}, bank_name = ${p.bankName ?? null},
            denomination = ${p.denomination ?? null},
            per_withdrawal_max = ${p.perWithdrawalMax ?? null},
            code_ttl_sec = ${p.codeTtlSec ?? null},
            fee_fixed = ${p.feeFixed}, fee_pct = ${p.feePct},
            city = ${p.city ?? null}, address = ${p.address ?? null},
            is_active = ${p.isActive}, updated_at = ${now}
        WHERE tenant_id = ${tenantId} AND code = ${p.code}
      `;
      console.log(`  update ${p.code}`);
      inserted++;
    } else {
      await sql`
        INSERT INTO exchange_payout_points
          (tenant_id, kind, code, label, bank_name, quote_asset,
           denomination, per_withdrawal_max, code_ttl_sec,
           fee_fixed, fee_pct, city, address, is_active, created_at, updated_at)
        VALUES (
          ${tenantId}, ${p.kind}, ${p.code}, ${p.label}, ${p.bankName ?? null},
          ${p.quoteAsset}, ${p.denomination ?? null}, ${p.perWithdrawalMax ?? null},
          ${p.codeTtlSec ?? null}, ${p.feeFixed}, ${p.feePct},
          ${p.city ?? null}, ${p.address ?? null}, ${p.isActive}, ${now}, ${now}
        )
      `;
      console.log(`  insert ${p.code}`);
      inserted++;
    }
  }

  console.log(`Done: ${inserted} upserted, ${skipped} skipped.`);
  await sql.end({ timeout: 0 });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
