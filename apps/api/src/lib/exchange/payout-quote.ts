/**
 * Расчёт наличной ВЫДАЧИ под способ — слой ПОВЕРХ котировки (computeQuote).
 * Курс здесь НЕ считается (его ведёт rate-feed/computeQuote); берём готовую
 * сумму к выдаче (amountToThb) и корректируем под физику способа выдачи.
 *
 * Правила «от земли» (см. справочник cardless-снятия):
 *  - ATM: округляем сумму ВНИЗ до шага номинала (denomination точки → дефолт
 *    валюты). Банкомат не выдаёт «мельче» — остаток клиенту не достаётся.
 *  - ATM: если сумма больше лимита одного снятия — дробим на несколько кодов
 *    (каждый кратен шагу и не больше лимита).
 *  - Доставка/курьер: удерживаем комиссию (fee_fixed + fee_pct%).
 *  - Офис/банк: без коррекции (выдаётся точная сумма).
 *
 * Чистая функция: без БД и I/O. Источник параметров точки/настроек резолвит
 * вызывающий (compute_exchange_quote), сюда приходят уже готовые значения.
 */

export type PayoutMethod =
  | "office_cash"
  | "cardless_atm"
  | "atm"
  | "courier_cash"
  | "thai_bank_transfer";

/** Шаг номинала по умолчанию (консервативно — гарантированно выдаётся банкоматом). */
export const CURRENCY_ROUND_STEP_DEFAULT: Record<string, number> = {
  // Многие тайские ATM по умолчанию выдают только 500/1000 — округляем до 500.
  THB: 500,
  PHP: 100,
};

/** Лимит одного cardless-снятия по умолчанию (универсальный пол по банкам). */
export const CURRENCY_PER_WITHDRAWAL_DEFAULT: Record<string, number> = {
  THB: 20_000,
  PHP: 10_000,
};

export interface PayoutPointParams {
  /** Шаг номинала точки; override дефолта валюты. */
  denomination?: number | null;
  /** Лимит одного cardless-снятия точки. */
  perWithdrawalMax?: number | null;
  feeFixed?: number | null;
  feePct?: number | null;
}

export interface PayoutAdjustmentInput {
  /** Базовая сумма к выдаче из котировки (amountToThb). */
  amount: number;
  /** Валюта выдачи (PHP/THB/…). */
  quoteAsset: string;
  method: PayoutMethod | string;
  point?: PayoutPointParams | null;
}

export interface PayoutAdjustment {
  method: string;
  /** Сумма до коррекции (вход). */
  baseAmount: number;
  /** Итог к выдаче после округления/комиссии. */
  payoutAmount: number;
  /** Шаг номинала, применённый для ATM (0 если не применялось). */
  roundStep: number;
  /** Остаток, не выданный из-за округления вниз (ATM). */
  roundingRemainder: number;
  /** Удержанная комиссия выдачи (доставка/курьер). */
  fee: number;
  /** Разбивка ATM-выдачи на коды (каждый кратен шагу); [] если не ATM/не нужно. */
  codes: number[];
  /** true, если способ требует выдачи через банкомат. */
  isAtm: boolean;
  /** false, если ATM-выдача невозможна (сумма меньше шага номинала). */
  dispensable: boolean;
  /** Человекочитаемое пояснение для бота. */
  note: string;
}

function isAtmMethod(method: string): boolean {
  return method === "cardless_atm" || method === "atm";
}

function isCourierMethod(method: string): boolean {
  return method === "courier_cash";
}

/** Дробит сумму на коды не больше perCodeMax (последний — остаток). */
function splitIntoCodes(amount: number, perCodeMax: number): number[] {
  const codes: number[] = [];
  let left = amount;
  while (left > perCodeMax) {
    codes.push(perCodeMax);
    left -= perCodeMax;
  }
  if (left > 0) codes.push(left);
  return codes;
}

export function applyPayoutAdjustment(input: PayoutAdjustmentInput): PayoutAdjustment {
  const base = Math.max(0, Math.round(input.amount));
  const ccy = input.quoteAsset;
  const method = input.method;
  const point = input.point ?? {};

  const passthrough: PayoutAdjustment = {
    method,
    baseAmount: base,
    payoutAmount: base,
    roundStep: 0,
    roundingRemainder: 0,
    fee: 0,
    codes: [],
    isAtm: false,
    dispensable: true,
    note: "",
  };

  if (isCourierMethod(method)) {
    const feePct = Number(point.feePct ?? 0);
    const feeFixed = Number(point.feeFixed ?? 0);
    const fee = Math.max(0, Math.round(feeFixed + (base * feePct) / 100));
    const payout = Math.max(0, base - fee);
    return {
      ...passthrough,
      payoutAmount: payout,
      fee,
      note: fee > 0 ? `Доставка: комиссия ${fee} ${ccy}, к выдаче ${payout} ${ccy}.` : "",
    };
  }

  // office_cash / thai_bank_transfer / прочее — точная сумма, без коррекции.
  if (!isAtmMethod(method)) return passthrough;

  // ATM: округление вниз до шага номинала.
  const step = Math.max(
    1,
    Math.floor(Number(point.denomination ?? CURRENCY_ROUND_STEP_DEFAULT[ccy] ?? 1)),
  );
  const payout = Math.floor(base / step) * step;
  const remainder = base - payout;

  // Дробление на коды по лимиту одного снятия (perCodeMax кратен шагу).
  const rawMax = Number(point.perWithdrawalMax ?? CURRENCY_PER_WITHDRAWAL_DEFAULT[ccy] ?? 0);
  const perCodeMax = rawMax > 0 ? Math.floor(rawMax / step) * step : 0;
  const codes =
    payout <= 0
      ? []
      : perCodeMax > 0 && payout > perCodeMax
        ? splitIntoCodes(payout, perCodeMax)
        : [payout];

  if (payout <= 0) {
    return {
      method,
      baseAmount: base,
      payoutAmount: 0,
      roundStep: step,
      roundingRemainder: base,
      fee: 0,
      codes: [],
      isAtm: true,
      dispensable: false,
      note: `Сумма ${base} ${ccy} меньше минимального номинала банкомата (${step} ${ccy}) — предложи другой способ выдачи или другую сумму.`,
    };
  }

  const parts = [`Банкомат выдаёт кратно ${step} ${ccy}: к выдаче ${payout} ${ccy}`];
  if (remainder > 0) parts.push(`(остаток ${remainder} ${ccy} не выдаётся банкоматом)`);
  if (codes.length > 1) parts.push(`— ${codes.length} кода/кодов: ${codes.join(" + ")}`);

  return {
    method,
    baseAmount: base,
    payoutAmount: payout,
    roundStep: step,
    roundingRemainder: remainder,
    fee: 0,
    codes,
    isAtm: true,
    dispensable: true,
    note: `${parts.join(" ")}.`,
  };
}
