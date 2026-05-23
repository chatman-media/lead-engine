#!/usr/bin/env bun
/**
 * Seed production sales-styles в `styles` таблицу. Использует
 * RECRUITMENT_STYLES из @chatman-media/vertical-recruitment —
 * 4 production-curated стиля для recruitment vertical.
 *
 * Usage:
 *   bun run apps/api/scripts/seed-styles.ts --tenant=legacy
 *
 * Идемпотентно: upsert через UPDATE на конфликте по (tenant_id, slug, version).
 * Если стиль уже существует в активной версии — обновляет config_json,
 * display_name. Новые стили — INSERT.
 *
 * Env:
 *   DATABASE_URL
 */

import { RECRUITMENT_STYLES } from "@chatman-media/vertical-recruitment";
import * as schema from "@chatman-media/storage";
import { styles, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

function parseTenant(): string {
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (k === "tenant" && v) return v;
  }
  throw new Error("--tenant=<slug> required");
}

async function main() {
  const tenantSlug = parseTenant();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL env required");

  const client = postgres(databaseUrl, { max: 2 });
  const db = drizzle(client, { schema });
  const now = Math.floor(Date.now() / 1000);

  try {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, tenantSlug));
    if (!tenant) throw new Error(`tenant slug=${tenantSlug} not found`);

    console.log(
      `[seed-styles] tenant=${tenant.slug} (id=${tenant.id}), styles=${RECRUITMENT_STYLES.length}`,
    );

    let inserted = 0;
    let updated = 0;
    for (const style of RECRUITMENT_STYLES) {
      const configJson = JSON.stringify(style);
      const displayName = style.displayName;

      // Lookup существующего active row per (tenant_id, slug).
      const [existing] = await db
        .select()
        .from(styles)
        .where(
          and(
            eq(styles.tenantId, tenant.id),
            eq(styles.slug, style.slug),
            eq(styles.isActive, true),
          ),
        );

      if (existing) {
        await db
          .update(styles)
          .set({ configJson, displayName })
          .where(eq(styles.id, existing.id));
        updated += 1;
      } else {
        await db.insert(styles).values({
          tenantId: tenant.id,
          slug: style.slug,
          displayName,
          configJson,
          isActive: true,
          version: 1,
          createdAt: now,
        });
        inserted += 1;
      }
    }

    console.log(`[seed-styles] done: ${inserted} inserted, ${updated} updated`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[seed-styles] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
