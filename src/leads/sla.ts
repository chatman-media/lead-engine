/**
 * Expected (operator-quoted) durations for the waiting stages of the
 * lead funnel. These are the figures the operator tells candidates —
 * "~10 days for documents, then 4-5 days for the visa" — used to pace
 * proactive check-in messages and to render UI hints.
 *
 * Distinct from the auto-close thresholds in `stale-sweep.ts`: those
 * decide when a silent lead is considered ghosted, these describe how
 * long the stage is *supposed* to take.
 */

/** `docs_pending` — candidate gathers and sends her documents. */
export const DOCS_EXPECTED_DAYS = 10;

/** `submitted` — consulate processes the filed visa application. */
export const VISA_EXPECTED_DAYS_MIN = 4;
export const VISA_EXPECTED_DAYS_MAX = 5;
