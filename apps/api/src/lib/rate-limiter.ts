/**
 * In-process per-tenant sliding-window rate limiter для inbound сообщений.
 *
 * Защищает от runaway-стоимости когда tenant'ский bot становится spam-
 * target'ом и LLM credits сжигаются за минуты. Counters per tenantId,
 * sliding windows 1min + 1hour.
 *
 * Tradeoffs (in-memory):
 *  + zero-latency check, no DB roundtrip per webhook
 *  + simple
 *  - restart сбрасывает window state (acceptable — attacker всё равно
 *    может только spam через тот же URL, который вернулся к нулю)
 *  - не cross-process (apps/api с N процессами увидит лимит × N).
 *    Для текущей single-instance конфиги OK; cross-process нужен Redis.
 *
 * Defaults (configurable via env RATE_LIMIT_PER_MIN / _HOUR):
 *  - 60 msg/min per tenant
 *  - 600 msg/hour per tenant
 */

export interface RateLimiterOptions {
  /** Max inbound сообщений per tenant per 60 sec. Default 60. */
  perMinute: number;
  /** Max inbound сообщений per tenant per 3600 sec. Default 600. */
  perHour: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: "per_minute" | "per_hour";
  retryAfterSec?: number;
  currentMinute?: number;
  currentHour?: number;
}

interface TenantWindow {
  /** Timestamps (epoch ms) последних inbound запросов. */
  timestamps: number[];
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export class InboundRateLimiter {
  private readonly opts: RateLimiterOptions;
  private readonly byTenant = new Map<number, TenantWindow>();

  constructor(opts: Partial<RateLimiterOptions> = {}) {
    this.opts = {
      perMinute: opts.perMinute ?? 60,
      perHour: opts.perHour ?? 600,
    };
  }

  /**
   * Регистрирует попытку inbound и решает можно ли её пропустить.
   * Если allowed=false — webhook handler возвращает 429.
   * Idempotent в случае allowed=false: НЕ инкрементит counter (мы не
   * "потребляем" rejected попытку).
   *
   * `limits` позволяет задать per-tenant override (например из PLAN_LIMITS) —
   * используется вместо глобального cfg. Если не задан — применяются
   * глобальные opts из конструктора.
   */
  check(tenantId: number, limits?: { perMinute?: number; perHour?: number }): RateLimitDecision {
    // Effective limit = the stricter of global opts and per-tenant plan limits.
    // Global opts act as a hard platform cap; plan limits apply per-tenant.
    // When global opts are 0 (disabled) — plan limits apply exclusively.
    const planMin = limits?.perMinute ?? this.opts.perMinute;
    const planHour = limits?.perHour ?? this.opts.perHour;
    const perMinute =
      this.opts.perMinute > 0 ? Math.min(planMin, this.opts.perMinute) : planMin;
    const perHour =
      this.opts.perHour > 0 ? Math.min(planHour, this.opts.perHour) : planHour;
    const now = Date.now();
    let win = this.byTenant.get(tenantId);
    if (!win) {
      win = { timestamps: [] };
      this.byTenant.set(tenantId, win);
    }

    // Pruning: убираем timestamps старше hour.
    const hourCutoff = now - HOUR_MS;
    const minuteCutoff = now - MINUTE_MS;
    win.timestamps = win.timestamps.filter((t) => t >= hourCutoff);

    const minuteCount = win.timestamps.filter((t) => t >= minuteCutoff).length;
    const hourCount = win.timestamps.length;

    if (minuteCount >= perMinute) {
      const oldestInMinute = win.timestamps.find((t) => t >= minuteCutoff) ?? now;
      const retry = Math.max(1, Math.ceil((oldestInMinute + MINUTE_MS - now) / 1000));
      return {
        allowed: false,
        reason: "per_minute",
        retryAfterSec: retry,
        currentMinute: minuteCount,
        currentHour: hourCount,
      };
    }
    if (hourCount >= perHour) {
      const oldestInHour = win.timestamps[0] ?? now;
      const retry = Math.max(1, Math.ceil((oldestInHour + HOUR_MS - now) / 1000));
      return {
        allowed: false,
        reason: "per_hour",
        retryAfterSec: retry,
        currentMinute: minuteCount,
        currentHour: hourCount,
      };
    }

    // Accept: register.
    win.timestamps.push(now);
    return { allowed: true, currentMinute: minuteCount + 1, currentHour: hourCount + 1 };
  }

  /** Stats для metrics / debugging. */
  stats(): { tenants: number; totalTracked: number } {
    let total = 0;
    for (const w of this.byTenant.values()) total += w.timestamps.length;
    return { tenants: this.byTenant.size, totalTracked: total };
  }
}
