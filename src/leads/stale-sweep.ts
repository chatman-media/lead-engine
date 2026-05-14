import type { Sql } from "../db/postgres.ts";

import { type LeadState, LeadsRepo } from "../db/repos/leads.ts";
import { type AttributionDeps, attributeLeadOutcome } from "./outcome-attribution.ts";

/**
 * "Ghosted" detector. A lead that hasn't seen a state transition in 14
 * days while still in a non-terminal state is auto-closed and counted
 * as a `lost` outcome. This populates the loss side of the win-rate
 * stats so the leaderboard isn't biased by "we only count wins".
 *
 * Only sweeps NON-terminal states. Terminal (submitted/docs_complete/
 * rejected/closed) leads stay where they are; their attribution
 * happened at the transition.
 */
const STALE_DAYS = 14;
const NON_TERMINAL: LeadState[] = ["intake_pending", "intake_complete", "approved", "docs_pending"];

export interface StaleSweepResult {
  scanned: number;
  closed: number;
  attributed: number;
}

/**
 * One sweep pass. Idempotent: a lead that was already closed by a
 * previous sweep is skipped (state filter on NON_TERMINAL).
 *
 * Cost is tiny — single SELECT + N updates where N is "leads going
 * stale this hour", typically 0-2.
 */
export async function runStaleLeadSweep(deps: AttributionDeps): Promise<StaleSweepResult> {
  const leads = new LeadsRepo(deps.db);
  const cutoff = Math.floor(Date.now() / 1000) - STALE_DAYS * 24 * 60 * 60;
  const stale = await leads.listStale(NON_TERMINAL, cutoff);

  let closed = 0;
  let attributed = 0;
  for (const row of stale) {
    const updated = await leads.setState(row.id, "closed");
    if (!updated) continue;
    closed++;
    const r = await attributeLeadOutcome(deps, updated);
    if (r.outcomesRecorded > 0) attributed += r.outcomesRecorded;
  }
  return { scanned: stale.length, closed, attributed };
}

/**
 * Schedule the sweep on a fixed interval. Returns the timer handle so
 * the caller can clearInterval on shutdown (tests do this).
 *
 * Default cadence is 6h — we don't need real-time gaming on this; daily
 * granularity for "ghosted" is fine. The first run fires after 60s so
 * boot diagnostics aren't noisy.
 */
export function scheduleStaleLeadSweep(
  deps: AttributionDeps,
  opts: { intervalMs?: number; firstRunAfterMs?: number } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000;
  const firstRunAfterMs = opts.firstRunAfterMs ?? 60 * 1000;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(function tick() {
    runStaleLeadSweep(deps)
      .then((r) => {
        if (r.closed > 0) {
          console.log(
            `[stale-sweep] closed ${r.closed} stale lead(s); attributed ${r.attributed} skill outcome(s)`,
          );
        }
      })
      .catch((err) => {
        console.warn("[stale-sweep] failed:", err);
      })
      .finally(() => {
        timer = setTimeout(tick, intervalMs);
      });
  }, firstRunAfterMs);
  return {
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
