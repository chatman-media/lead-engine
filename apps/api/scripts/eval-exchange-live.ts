#!/usr/bin/env bun

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  channels,
  exchangeRates,
  schema,
  tenantFeatureFlags,
  tenants,
} from "@chatman-media/storage";
import { and, sql as drizzleSql, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  createDeterministicExchangeLiveEvalRunner,
  type ExchangeLiveEvalSeedSnapshot,
  formatExchangeLiveEvalSummary,
  runExchangeLiveEval,
} from "../src/lib/exchange/live-eval.ts";

interface Args {
  scenarioId?: string;
  output?: string;
  json: boolean;
  tenantSlug?: string;
  tenantId?: number;
  requireSeed: boolean;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: bun run scripts/eval-exchange-live.ts [--scenario=<id>] [--output=<file>] [--json]",
    "",
    "Deterministic exchange live-eval smoke runner. No external LLM is used.",
    "",
    "Seed snapshot:",
    "  --tenant=<slug>       Load seed snapshot from DATABASE_URL",
    "  --tenant-id=<id>      Load seed snapshot by id",
    "  --require-seed        Fail if active channels/rates are missing",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { json: false, requireSeed: false, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--require-seed") args.requireSeed = true;
    else if (arg.startsWith("--scenario=")) {
      args.scenarioId = arg.slice("--scenario=".length);
    } else if (arg.startsWith("--output=")) {
      args.output = arg.slice("--output=".length);
    } else if (arg.startsWith("--tenant=")) {
      args.tenantSlug = arg.slice("--tenant=".length);
    } else if (arg.startsWith("--tenant-id=")) {
      const id = Number(arg.slice("--tenant-id=".length));
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("--tenant-id must be a positive integer");
      }
      args.tenantId = id;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (args.tenantSlug && args.tenantId) {
    throw new Error("Use either --tenant or --tenant-id, not both");
  }
  if (args.requireSeed && !args.tenantSlug && !args.tenantId) {
    throw new Error("--require-seed requires --tenant or --tenant-id");
  }
  return args;
}

async function loadSeedSnapshot(args: Args): Promise<{
  seed?: ExchangeLiveEvalSeedSnapshot;
  close: () => Promise<void>;
}> {
  if (!args.tenantSlug && !args.tenantId) return { close: async () => {} };
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when --tenant/--tenant-id is used");
  }
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  const db = drizzle(sql, { schema }) as unknown as Db;
  const close = async () => {
    await sql.end({ timeout: 0 }).catch(() => {});
  };
  const [tenant] = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(args.tenantId ? eq(tenants.id, args.tenantId) : eq(tenants.slug, args.tenantSlug ?? ""))
    .limit(1);
  if (!tenant) {
    await close();
    throw new Error(`Tenant not found: ${args.tenantId ?? args.tenantSlug}`);
  }
  const seed = await withTenant(db, tenant.id, async (tx) => {
    const [channelCount] = await tx
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(channels)
      .where(and(eq(channels.tenantId, tenant.id), eq(channels.status, "active")));
    const [rateCount] = await tx
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.tenantId, tenant.id), eq(exchangeRates.isActive, true)));
    const [guardFlag] = await tx
      .select({ enabled: tenantFeatureFlags.enabled })
      .from(tenantFeatureFlags)
      .where(
        and(
          eq(tenantFeatureFlags.tenantId, tenant.id),
          eq(tenantFeatureFlags.featureKey, "exchange_response_guard"),
        ),
      )
      .limit(1);
    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      activeChannels: Number(channelCount?.count ?? 0),
      activeRates: Number(rateCount?.count ?? 0),
      exchangeResponseGuardEnabled: guardFlag?.enabled !== false,
    };
  });
  return { seed, close };
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const { seed, close } = await loadSeedSnapshot(args);
  try {
    if (args.requireSeed && seed) {
      if (seed.activeChannels === 0) throw new Error("Seed check failed: no active channels");
      if (seed.activeRates === 0) throw new Error("Seed check failed: no active exchange rates");
    }
    const report = await runExchangeLiveEval({
      runner: createDeterministicExchangeLiveEvalRunner(),
      scenarioId: args.scenarioId,
      seed,
    });
    if (args.output) {
      await Bun.write(args.output, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(formatExchangeLiveEvalSummary(report));
      if (args.output) console.log(`Wrote report: ${args.output}`);
    }
    if (report.passed !== report.total) process.exitCode = 1;
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
