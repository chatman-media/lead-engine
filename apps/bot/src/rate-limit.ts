// In-memory per-key token bucket. Cheap protection against floods on
// /telegram/<secret> if the secret leaks, and against brute-force on the
// admin login. Single-process — multi-instance deployment would replace
// this with Redis or a PostgreSQL window function.
//
// Buckets are keyed by caller-chosen string (typically IP or session-cookie).
// Each call to `check` returns whether the request is allowed and refills
// the bucket according to elapsed time.

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiterOptions {
  /** Bucket capacity (max burst). */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSec: number;
  /** Max bucket entries before LRU prune kicks in. Default 10_000. */
  maxEntries?: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly maxEntries: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  /** Try to consume one token from the bucket for `key`. Returns true if
   *  allowed, false if rate-limited. */
  check(key: string, now: number = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      // Cap the bucket map so a flood of unique keys doesn't blow memory.
      // Map preserves insertion order — first-inserted (oldest) goes first.
      if (this.buckets.size >= this.maxEntries) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      b = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = (now - b.updatedAt) / 1000;
      if (elapsedSec > 0) {
        b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
        b.updatedAt = now;
      }
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Test hook — drop all buckets. */
  __resetForTesting(): void {
    this.buckets.clear();
  }
}

/** Best-effort IP extraction from common reverse-proxy headers. Falls back
 *  to a constant when nothing matches — that yields global rate-limiting,
 *  not per-IP, which is the safe failure mode. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return "unknown";
}
