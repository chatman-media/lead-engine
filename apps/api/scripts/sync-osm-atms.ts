#!/usr/bin/env bun

/**
 * CLI wrapper для syncOsmAtms. Для запуска вручную или по крону.
 *
 * Usage:
 *   DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
 *   TENANT_SLUG=phdemo \
 *   bun run apps/api/scripts/sync-osm-atms.ts
 *
 * Env:
 *   BBOX       "lat_min,lng_min,lat_max,lng_max"  (default: Metro Manila)
 *   DRY_RUN=1  Только показать что будет загружено (без записи в БД)
 *   QUOTE_ASSET  PHP (default)
 */

import { schema } from "@chatman-media/storage";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { DEFAULT_PH_BBOX, fetchOsmAtms, resolveBankConfig } from "../src/lib/exchange/osm-sync.ts";

const ownerUrl = process.env.DATABASE_URL;
if (!ownerUrl) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
const tenantSlug = process.env.TENANT_SLUG ?? "phdemo";
const dryRun = process.env.DRY_RUN === "1";
const bbox = process.env.BBOX ?? DEFAULT_PH_BBOX;
const quoteAsset = process.env.QUOTE_ASSET ?? "PHP";

async function run() {
  const sql = postgres(ownerUrl!, { max: 2, onnotice: () => {} });

  const [tenant] = await sql<{ id: number }[]>`
    SELECT id FROM tenants WHERE slug = ${tenantSlug} LIMIT 1
  `;
  if (!tenant) {
    console.error(`Tenant "${tenantSlug}" not found.`);
    await sql.end({ timeout: 0 });
    process.exit(1);
  }
  console.log(`Tenant: #${tenant.id} (${tenantSlug})`);

  const nodes = await fetchOsmAtms(bbox);
  console.log(`Fetched ${nodes.length} ATM nodes from OSM (bbox=${bbox})`);

  if (dryRun) {
    let matched = 0;
    for (const node of nodes) {
      const cfg = resolveBankConfig(node.tags ?? {});
      if (cfg) {
        console.log(
          `  [dry] osm:${node.id} → ${cfg.bankName} (${node.lat.toFixed(5)},${node.lon.toFixed(5)})`,
        );
        matched++;
      }
    }
    console.log(`\nWould upsert: ${matched}  skip: ${nodes.length - matched}`);
    await sql.end({ timeout: 0 });
    return;
  }

  const db = drizzle(sql, { schema });
  const { syncOsmAtms } = await import("../src/lib/exchange/osm-sync.ts");
  const result = await syncOsmAtms(db as never, tenant.id, { bbox, quoteAsset });

  console.log(
    `Done: ${result.upserted} upserted, ${result.skipped} skipped (unknown bank) of ${result.fetched} fetched.`,
  );
  await sql.end({ timeout: 0 });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
