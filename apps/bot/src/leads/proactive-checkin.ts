import type { LeadState, LeadsRepo } from "../db/repos/leads.ts";
import type { UsersRepo } from "../db/repos/users.ts";
import type { LeadsService } from "./service.ts";
import { proactiveCheckinMessage } from "./templates.ts";

/**
 * Proactive waiting-period check-ins.
 *
 * After approval a candidate waits ~2 weeks — ~10 days collecting her
 * documents (`docs_pending`), then ~4-5 days on the consulate decision
 * (`submitted`). The bot otherwise only replies when she writes; a
 * silent candidate hears nothing and starts to worry / drop off. This
 * scheduler DMs a warm "как дела?" nudge once she has been quiet in a
 * waiting stage for `intervalDays`.
 *
 * Opt-in via `LEAD_PROACTIVE_CHECKINS` — proactive outbound messaging is
 * a deliberate operator choice.
 */

/** Waiting states the bot checks in on, mapped to the message tone. */
const CHECKIN_PHASES: Record<string, "docs" | "submitted"> = {
  docs_pending: "docs",
  submitted: "submitted",
};
const CHECKIN_STATES = Object.keys(CHECKIN_PHASES) as LeadState[];

export interface ProactiveCheckinDeps {
  leads: LeadsRepo;
  users: UsersRepo;
  service: LeadsService;
  /** Days a lead must be quiet in a waiting stage before the next
   *  check-in (also the delay from stage entry to the first one). */
  intervalDays: number;
}

export interface ProactiveCheckinResult {
  scanned: number;
  sent: number;
}

/**
 * One check-in pass. For each lead in a waiting stage, the next nudge is
 * due once `intervalDays` have passed since the later of (stage entry,
 * last check-in) — so the first nudge lands `intervalDays` after entry
 * and they recur at that cadence until the lead moves on.
 *
 * Idempotent within a pass: `markCheckinSent` advances the baseline, so
 * a re-run before the interval elapses sends nothing.
 */
export async function runProactiveCheckins(
  deps: ProactiveCheckinDeps,
): Promise<ProactiveCheckinResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const intervalSec = deps.intervalDays * 24 * 60 * 60;
  const candidates = await deps.leads.listCheckinCandidates(CHECKIN_STATES);

  let sent = 0;
  for (const c of candidates) {
    const phase = CHECKIN_PHASES[c.state];
    if (!phase) continue;
    // No recorded stage-entry event — skip rather than nudge immediately.
    if (c.stage_entered_at == null) continue;
    const baseline = Math.max(c.stage_entered_at, c.last_checkin_at ?? 0);
    if (nowSec - baseline < intervalSec) continue;

    const user = await deps.users.byId(c.user_id);
    if (!user) continue;
    await deps.service.sendProactiveCheckin({
      user,
      text: proactiveCheckinMessage(phase),
    });
    await deps.leads.markCheckinSent(c.id, nowSec);
    sent++;
  }
  return { scanned: candidates.length, sent };
}

/**
 * Schedule the check-in pass on a fixed interval. Returns the handle so
 * the caller can stop it on shutdown (tests do this).
 *
 * Cadence is 6h — the per-lead due check is day-granular, so a tighter
 * loop buys nothing. First run after 90s to stay out of boot noise.
 */
export function scheduleProactiveCheckins(
  deps: ProactiveCheckinDeps,
  opts: { intervalMs?: number; firstRunAfterMs?: number } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000;
  const firstRunAfterMs = opts.firstRunAfterMs ?? 90 * 1000;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(function tick() {
    runProactiveCheckins(deps)
      .then((r) => {
        if (r.sent > 0) {
          console.log(`[proactive-checkin] sent ${r.sent} check-in(s)`);
        }
      })
      .catch((err) => {
        console.warn("[proactive-checkin] failed:", err);
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
