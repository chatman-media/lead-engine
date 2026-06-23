#!/usr/bin/env bun
/**
 * Seed deterministic exchange QA/demo fixtures into an existing tenant.
 *
 * Usage:
 *   DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
 *   PLATFORM_MASTER_KEY=<64hex> \
 *   bun run apps/api/scripts/seed-exchange-fixtures.ts --tenant=bob-demo
 *
 * Dry-run:
 *   bun run apps/api/scripts/seed-exchange-fixtures.ts --tenant=bob-demo --dry-run
 */

import { type Db } from "@chatman-media/conversation-engine";
import { schema, tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  EXCHANGE_FIXTURE_KB_DOCUMENTS,
  EXCHANGE_FIXTURE_OFFICES,
  EXCHANGE_FIXTURE_RATES,
  EXCHANGE_FIXTURE_RATE_TIERS,
  EXCHANGE_FIXTURE_SCENARIO_KEYS,
  EXCHANGE_FIXTURE_SECRETS,
  seedExchangeFixtures,
} from "../src/lib/exchange/fixtures.ts";

interface Args {
  tenantSlug: string | null;
  tenantId: number | null;
  dryRun: boolean;
}

function parseArgs(): Args {
  const out: Partial<Args> = { dryRun: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    const [rawKey, ...rest] = arg.replace(/^--/, "").split("=");
    const value = rest.join("=");
    if (!rawKey || value === undefined) continue;
    if (rawKey === "tenant") out.tenantSlug = value;
    else if (rawKey === "tenant-id") out.tenantId = Number(value);
  }
  if (!out.tenantSlug && out.tenantId == null) {
    throw new Error("--tenant=<slug> or --tenant-id=<id> required");
  }
  if (out.tenantId != null && !Number.isInteger(out.tenantId)) {
    throw new Error("--tenant-id must be an integer");
  }
  return {
    tenantSlug: out.tenantSlug ?? null,
    tenantId: out.tenantId ?? null,
    dryRun: out.dryRun ?? false,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`env ${name} required`);
  return value;
}

async function resolveTenantId(db: Db, args: Args): Promise<number> {
  if (args.tenantId != null) return args.tenantId;
  if (!args.tenantSlug) throw new Error("tenant slug missing");
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, args.tenantSlug))
    .limit(1);
  if (!tenant) throw new Error(`tenant not found: ${args.tenantSlug}`);
  return tenant.id;
}

function printPlan(args: Args, tenantId: number | null): void {
  console.log("[seed-exchange-fixtures] plan");
  console.log(`  tenant: ${args.tenantSlug ?? args.tenantId}`);
  if (tenantId != null) console.log(`  tenant_id: ${tenantId}`);
  console.log(`  offices: ${EXCHANGE_FIXTURE_OFFICES.length}`);
  console.log(`  rates: ${EXCHANGE_FIXTURE_RATES.length}`);
  console.log(`  rate tiers: ${EXCHANGE_FIXTURE_RATE_TIERS.length}`);
  console.log(`  encrypted secrets: ${EXCHANGE_FIXTURE_SECRETS.length}`);
  console.log(`  kb documents: ${EXCHANGE_FIXTURE_KB_DOCUMENTS.length}`);
  console.log(`  scenario keys: ${EXCHANGE_FIXTURE_SCENARIO_KEYS.join(", ")}`);
}

async function main() {
  const args = parseArgs();
  const databaseUrl = requiredEnv("DATABASE_URL");
  const client = postgres(databaseUrl, { max: 2 });
  const db = drizzle(client, { schema }) as Db;

  try {
    const tenantId = await resolveTenantId(db, args);
    printPlan(args, tenantId);

    if (args.dryRun) {
      console.log("[seed-exchange-fixtures] dry-run: no writes");
      return;
    }

    const masterKeyHex = requiredEnv("PLATFORM_MASTER_KEY");
    const result = await seedExchangeFixtures({
      db,
      tenantId,
      masterKeyHex,
    });
    console.log("[seed-exchange-fixtures] seeded");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end({ timeout: 0 }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("[seed-exchange-fixtures] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
