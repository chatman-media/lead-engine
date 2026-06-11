/**
 * In-process sliding-window rate limiter keyed by an arbitrary string
 * (IP, IP+email, …). Used to throttle public `/api/auth/*` endpoints
 * against brute-force / credential-stuffing / email-bombing.
 *
 * Same tradeoffs as InboundRateLimiter (lib/rate-limiter.ts):
 *  - in-memory, per-process (restart resets; multi-process undercounts)
 *  - zero-latency, no DB roundtrip
 * For the current single-instance API process this is sufficient; a
 * cross-process deployment would move this to Redis.
 */

export interface AuthRateLimitDecision {
  allowed: boolean;
  retryAfterSec?: number;
}

interface KeyWindow {
  /** Timestamps (epoch ms) of accepted attempts. */
  timestamps: number[];
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface AuthRateLimiterOptions {
  /** Max attempts per key per 60 sec. Default 10. */
  perMinute: number;
  /** Max attempts per key per 3600 sec. Default 60. */
  perHour: number;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
}

export class AuthRateLimiter {
  private readonly perMinute: number;
  private readonly perHour: number;
  private readonly now: () => number;
  private readonly byKey = new Map<string, KeyWindow>();

  constructor(opts: Partial<AuthRateLimiterOptions> = {}) {
    this.perMinute = opts.perMinute ?? 10;
    this.perHour = opts.perHour ?? 60;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Registers an attempt for `key` and decides whether to allow it.
   * On rejection the attempt is NOT counted (we don't consume rejected tries),
   * matching InboundRateLimiter semantics.
   */
  check(key: string): AuthRateLimitDecision {
    const now = this.now();
    let win = this.byKey.get(key);
    if (!win) {
      win = { timestamps: [] };
      this.byKey.set(key, win);
    }

    const hourCutoff = now - HOUR_MS;
    const minuteCutoff = now - MINUTE_MS;
    win.timestamps = win.timestamps.filter((t) => t >= hourCutoff);

    const minuteCount = win.timestamps.filter((t) => t >= minuteCutoff).length;
    const hourCount = win.timestamps.length;

    if (minuteCount >= this.perMinute) {
      const oldestInMinute = win.timestamps.find((t) => t >= minuteCutoff) ?? now;
      const retry = Math.max(1, Math.ceil((oldestInMinute + MINUTE_MS - now) / 1000));
      return { allowed: false, retryAfterSec: retry };
    }
    if (hourCount >= this.perHour) {
      const oldestInHour = win.timestamps[0] ?? now;
      const retry = Math.max(1, Math.ceil((oldestInHour + HOUR_MS - now) / 1000));
      return { allowed: false, retryAfterSec: retry };
    }

    win.timestamps.push(now);
    return { allowed: true };
  }

  /** Drops all tracked windows (test helper). */
  reset(): void {
    this.byKey.clear();
  }
}

/**
 * Best-effort client IP extraction for rate-limit keying. Reads the first hop
 * of `X-Forwarded-For` (set by the reverse proxy), falling back to `X-Real-IP`.
 * Returns `"unknown"` when no proxy header is present — all such requests share
 * a bucket, which is acceptable (fail-closed-ish) for an abuse limiter.
 */
export function clientIpFromHeaders(headers: {
  get(name: string): string | null | undefined;
}): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real?.trim()) return real.trim();
  return "unknown";
}
