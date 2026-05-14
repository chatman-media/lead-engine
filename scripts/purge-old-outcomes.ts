#!/usr/bin/env bun
/**
 * Purge old skill_outcomes and self_play_matches rows to keep the DB lean.
 *
 * By default keeps the last 90 days of data. Override with --days=N.
 * Use --dry-run to see what would be deleted without actually deleting.
 *
 * Usage:
 *   bun scripts/purge-old-outcomes.ts
 *   bun scripts/purge-old-outcomes.ts --days=30
 *   bun scripts/purge-old-outcomes.ts --dry-run
 *
 * What gets purged:
 *   - skill_outcomes rows older than --days (source=self_play or real_conversation)
 *   - self_play_matches rows older than --days that are NOT referenced by
 *     pairwise_matches or shadow_evaluations (referenced rows are kept)
 *
 * What is NOT touched:
 *   - pairwise_matches (referenced by shadow_evaluations — leave intact)
 *   - shadow_evaluations (operational state — leave intact)
 *   - coach_proposals (audit trail — leave intact)
 *   - style_ratings (aggregated ELO — not time-series, always small)
 */

import { sql } from "../src/db/postgres.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const daysArg = args.find((a) => a.startsWith("--days="));
const days = daysArg ? parseInt(daysArg.split("=")[1]!, 10) : 90;

if (Number.isNaN(days) || days < 1) {
  console.error("--days must be a positive integer");
  process.exit(1);
}

const cutoffEpoch = Math.floor(Date.now() / 1000) - days * 86400;
const cutoffIso = new Date(cutoffEpoch * 1000).toISOString();

console.log(`Purge cutoff: ${cutoffIso} (${days} days ago)${dryRun ? " [DRY RUN]" : ""}`);

// --- skill_outcomes ---
const [outcomesRow] = await sql<{ n: number }[]>`
  SELECT COUNT(*)::INTEGER AS n FROM skill_outcomes WHERE created_at < ${cutoffEpoch}
`;
console.log(`skill_outcomes to delete: ${outcomesRow?.n ?? 0}`);

if (!dryRun && (outcomesRow?.n ?? 0) > 0) {
  const res = await sql`DELETE FROM skill_outcomes WHERE created_at < ${cutoffEpoch}`;
  console.log(`  deleted ${res.count} skill_outcomes rows`);
}

// --- self_play_matches (only those NOT referenced by pairwise_matches) ---
const [matchesRow] = await sql<{ n: number }[]>`
  SELECT COUNT(*)::INTEGER AS n
  FROM self_play_matches m
  WHERE m.created_at < ${cutoffEpoch}
    AND m.id NOT IN (
      SELECT solo_match_a_id FROM pairwise_matches WHERE solo_match_a_id IS NOT NULL
      UNION
      SELECT solo_match_b_id FROM pairwise_matches WHERE solo_match_b_id IS NOT NULL
    )
`;
console.log(`self_play_matches to delete (unreferenced): ${matchesRow?.n ?? 0}`);

if (!dryRun && (matchesRow?.n ?? 0) > 0) {
  const res = await sql`
    DELETE FROM self_play_matches
    WHERE created_at < ${cutoffEpoch}
      AND id NOT IN (
        SELECT solo_match_a_id FROM pairwise_matches WHERE solo_match_a_id IS NOT NULL
        UNION
        SELECT solo_match_b_id FROM pairwise_matches WHERE solo_match_b_id IS NOT NULL
      )
  `;
  console.log(`  deleted ${res.count} self_play_matches rows`);
}

if (dryRun) {
  console.log("[DRY RUN] no changes made");
} else {
  console.log("Done.");
}

await sql.end();
