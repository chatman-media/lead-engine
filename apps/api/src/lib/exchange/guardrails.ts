/**
 * Синхронные guardrails курса (quote-time). Чистая, детерминированная защита от
 * отдачи клиенту грубо неадекватной котировки.
 *
 * Идея: эффективный курс `eff`, по которому считаем сделку, сравниваем с
 * `base_rate` (ориентир обменника — фид держит его свежим для auto-строк, для
 * ручных строк это доверенное значение оператора). Допустимое отклонение:
 *   deviation = (eff/base - 1) * 100
 * Если |deviation| > maxDeviationPct — котировку НЕ отдаём: это либо опечатка в
 * rate-card (напр. 10 вместо 35 → −71%), либо мусор из фида, либо курс настолько
 * мимо рынка, что бот выглядит сломанным / уходит в явный убыток.
 *
 * ПОЧЕМУ полоса симметричная и широкая (а не «floor прибыльности у 0»): легальные
 * объёмные тарифы намеренно идут по обе стороны base (volume-discount — крупные
 * суммы получают курс лучше рыночного, на несколько процентов «в минус» к base).
 * Жёсткий floor у нуля ронял бы их ложно. Тонкую защиту «не продавать в убыток»
 * держим на save-time (маржа ≥ 0 в формуле) и на дрейфе base vs живой рынок (#144).
 * Здесь сеть не дёргаем — base и есть ориентир.
 */

export interface ExchangeGuardrails {
  /** Макс. |отклонение eff от base|, %. Дефолт 35 — выше похоже на опечатку/глюк. */
  maxDeviationPct: number;
  /** Допуск на округление, %. */
  epsPct: number;
}

export type RateGuardReason = "nonpositive" | "implausible_deviation";

export interface RateGuardTrip {
  tripped: boolean;
  reason?: RateGuardReason;
  /** Отклонение eff от base, % со знаком (NaN если оценить нельзя). */
  deviationPct: number;
  baseRate: number;
  eff: number;
  /** Нарушенный порог, для сообщения/алерта. */
  threshold?: number;
}

const DEFAULT_MAX_DEVIATION_PCT = 35;
const DEFAULT_EPS_PCT = 0.5;

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Дефолтные пороги из env (с разумными константами). Точка расширения для
 * per-tenant конфига (UI порогов — #145): передавайте свой объект в computeQuote.
 */
export function defaultGuardrails(): ExchangeGuardrails {
  return {
    maxDeviationPct: envNum("EXCHANGE_GUARD_MAX_DEVIATION_PCT", DEFAULT_MAX_DEVIATION_PCT),
    epsPct: envNum("EXCHANGE_GUARD_EPS_PCT", DEFAULT_EPS_PCT),
  };
}

/**
 * Проверка эффективного курса. Работает одинаково для базовой формулы и для
 * tier.deviationPct (последний раньше ОБХОДИЛ любые проверки — это и был кейс
 * «10 вместо 35»).
 */
export function checkRateGuard(opts: {
  eff: number;
  baseRate: number;
  mode: "multiply" | "divide";
  guardrails?: ExchangeGuardrails;
}): RateGuardTrip {
  const { eff, baseRate } = opts;
  const g = opts.guardrails ?? defaultGuardrails();

  if (!Number.isFinite(eff) || eff <= 0) {
    return {
      tripped: true,
      reason: "nonpositive",
      deviationPct: Number.NaN,
      baseRate,
      eff,
    };
  }
  // База невалидна (например, auto-строка ещё не заполнена фидом) — оценить
  // отклонение нельзя; пусть это ловят другие проверки (eff<=0 / отсутствие курса).
  if (!Number.isFinite(baseRate) || baseRate <= 0) {
    return { tripped: false, deviationPct: Number.NaN, baseRate, eff };
  }

  const deviationPct = (eff / baseRate - 1) * 100;
  if (Math.abs(deviationPct) > g.maxDeviationPct + g.epsPct) {
    return {
      tripped: true,
      reason: "implausible_deviation",
      deviationPct,
      baseRate,
      eff,
      threshold: g.maxDeviationPct,
    };
  }
  return { tripped: false, deviationPct, baseRate, eff };
}
