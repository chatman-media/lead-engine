/**
 * Background OpenRouter balance monitor.
 *
 * Runs every few hours: refreshes the cached balance (so `/admin/status`
 * has a fresh number) and, when the remaining credit drops below the
 * configured threshold, DMs the operator once per cooldown window so a
 * paid bot never silently runs out of money.
 *
 * Mirrors the scheduler shape of `scheduleStaleLeadSweep`.
 */

import type { TelegramClient } from "../telegram/client.ts";
import { fetchOpenRouterCredits, type OpenRouterCredits, setCachedCredits } from "./credits.ts";

/** Don't re-alert more than once per this window while the balance stays low. */
const ALERT_COOLDOWN_SEC = 20 * 60 * 60;

export interface BalanceMonitorDeps {
  telegram: Pick<TelegramClient, "sendMessage">;
  apiKey: string;
  baseUrl: string;
  /** Remaining USD below which the operator is alerted. */
  lowBalanceUsd: number;
  /** Telegram user id to DM. `null` → balance is still cached, no alert. */
  adminTgId: number | null;
  publicBaseUrl: string;
  /** Override the balance fetch (tests inject a fake). */
  fetchCredits?: () => Promise<OpenRouterCredits>;
}

export interface BalanceCheckResult {
  ok: boolean;
  remaining?: number;
  alerted: boolean;
  /** Updated last-alert epoch — feed it back into the next call. */
  lastAlertAt: number;
}

/**
 * One balance check. Pure-ish: `lastAlertAt` is passed in and the updated
 * value returned, so the cooldown is testable without module-level state.
 */
export async function runBalanceCheck(
  deps: BalanceMonitorDeps,
  lastAlertAt: number,
): Promise<BalanceCheckResult> {
  let credits: OpenRouterCredits;
  try {
    credits = deps.fetchCredits
      ? await deps.fetchCredits()
      : await fetchOpenRouterCredits({ apiKey: deps.apiKey, baseUrl: deps.baseUrl });
  } catch (err) {
    console.warn(
      "[openrouter-balance] check failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, alerted: false, lastAlertAt };
  }
  setCachedCredits(credits);

  const nowSec = Math.floor(Date.now() / 1000);
  const low = credits.remaining < deps.lowBalanceUsd;
  const cooledDown = nowSec - lastAlertAt >= ALERT_COOLDOWN_SEC;
  if (!low || deps.adminTgId == null || !cooledDown) {
    return { ok: true, remaining: credits.remaining, alerted: false, lastAlertAt };
  }

  await deps.telegram
    .sendMessage({
      chatId: deps.adminTgId,
      text:
        `⚠️ Баланс OpenRouter заканчивается: $${credits.remaining.toFixed(2)} ` +
        `(порог $${deps.lowBalanceUsd}).\n\n` +
        `Пополнить: https://openrouter.ai/credits\n` +
        `Статус бота: ${deps.publicBaseUrl}/admin/status`,
    })
    .catch(() => undefined);
  return { ok: true, remaining: credits.remaining, alerted: true, lastAlertAt: nowSec };
}

/**
 * Schedule the balance check on a fixed interval. Returns a handle with
 * `stop()` for shutdown / tests. Default cadence 6h; first run after 2 min
 * to stay out of boot noise.
 */
export function scheduleOpenRouterBalanceMonitor(
  deps: BalanceMonitorDeps,
  opts: { intervalMs?: number; firstRunAfterMs?: number } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000;
  const firstRunAfterMs = opts.firstRunAfterMs ?? 2 * 60 * 1000;
  let lastAlertAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(function tick() {
    runBalanceCheck(deps, lastAlertAt)
      .then((r) => {
        lastAlertAt = r.lastAlertAt;
        if (r.alerted) console.log("[openrouter-balance] low-balance alert sent to operator");
      })
      .catch((err) => {
        console.warn("[openrouter-balance] monitor error:", err);
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
