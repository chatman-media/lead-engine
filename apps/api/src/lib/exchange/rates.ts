/**
 * Курс и формула обменника. ДЕТЕРМИНИРОВАННО — LLM никогда не считает курс сам,
 * только зачитывает результат computeQuote().
 *
 * Семантика курса зависит от quote_mode:
 *   - 'multiply' (крипта): rate = THB за 1 единицу asset; thb = amount * eff;
 *                          маржа уменьшает курс: eff = base * (1 - margin/100).
 *   - 'divide'   (RUB):    rate = RUB за 1 THB;       thb = amount / eff;
 *                          маржа увеличивает курс: eff = base * (1 + margin/100).
 */

import {
  type Db,
  QUOTE_CURRENCY,
  type QuoteCurrency,
  resolveQuoteCurrency,
  withTenant,
} from "@chatman-media/conversation-engine";
import { exchangeRates, exchangeRateTiers, exchangeSettings } from "@chatman-media/storage";
import { and, asc, eq } from "drizzle-orm";
import {
  checkRateGuard,
  type ExchangeGuardrails,
  type RateGuardTrip,
} from "./guardrails.ts";

/** @deprecated Платформенный дефолт; рабочая валюта — per-tenant (getTenantQuoteCurrency). */
export const QUOTE_ASSET = QUOTE_CURRENCY.code;

/**
 * Котируемая валюта тенанта. Порядок: настройка exchange_settings.quote_asset
 * (правится в админке) → валюта активных курсов тенанта (legacy-тенанты без
 * настройки) → платформенный дефолт (PHP / env EXCHANGE_QUOTE_ASSET).
 */
export async function getTenantQuoteCurrency(db: Db, tenantId: number): Promise<QuoteCurrency> {
  return withTenant(db, tenantId, async (tx) => {
    const [s] = await tx
      .select({ quoteAsset: exchangeSettings.quoteAsset })
      .from(exchangeSettings)
      .where(eq(exchangeSettings.tenantId, tenantId))
      .limit(1);
    if (s?.quoteAsset) return resolveQuoteCurrency(s.quoteAsset);
    const [rate] = await tx
      .select({ quoteAsset: exchangeRates.quoteAsset })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.tenantId, tenantId), eq(exchangeRates.isActive, true)))
      .orderBy(asc(exchangeRates.id))
      .limit(1);
    if (rate?.quoteAsset) return resolveQuoteCurrency(rate.quoteAsset);
    return QUOTE_CURRENCY;
  });
}
export const CRYPTO_ASSETS = ["USDT", "USDC", "BTC", "ETH", "LTC", "TRX", "TON"] as const;

export interface QuoteResult {
  ok: true;
  direction: string; // "USDT->PHP"
  asset: string; // "USDT"
  /** Котируемая валюта тенанта на момент расчёта. */
  quoteAsset: string; // "PHP"
  network: string; // "TRC20" | ""
  amountMode: "source_amount" | "target_thb";
  amountFrom: number;
  rate: number; // эффективный курс, как показываем клиенту
  quoteMode: "multiply" | "divide";
  amountToThb: number; // округлённая сумма к получению
  marginPct: number;
  feeFixedThb: number;
}
export interface QuoteError {
  ok: false;
  error: string;
  /** Заполнено, если котировку заблокировал guardrail (а не обычная валидация). */
  guard?: RateGuardTrip;
}

export function normAsset(a: string): string {
  return a.trim().toUpperCase();
}
export function normNetwork(n?: string | null): string {
  return (n ?? "").trim().toLowerCase().replace(/-/g, "");
}
export function isCryptoAsset(asset: string): boolean {
  return (CRYPTO_ASSETS as readonly string[]).includes(asset);
}

/** Нормализует сеть: для USDT по умолчанию trc20, для фиата — пусто. */
export function resolveNetwork(asset: string, network?: string | null): string {
  if (!isCryptoAsset(asset)) return "";
  let net = normNetwork(network);
  if (asset === "USDT" && !net) net = "trc20";
  if (asset === "USDC" && !net) net = "erc20";
  if (asset === "ETH" && !net) net = "erc20";
  if (asset === "TRX" && !net) net = "tron";
  if (asset === "TON" && !net) net = "ton";
  return net;
}

interface RateRow {
  id: number;
  baseRate: number;
  quoteMode: string;
  marginPct: number;
  feeFixedThb: number;
  minAmountFrom: number | null;
  maxAmountFrom: number | null;
}

interface TierRow {
  marketRate: number;
  displayRate: number;
  deviationPct: number;
  minAmount: number;
  maxAmount: number | null;
}

async function findActiveRateRow(
  db: Db,
  tenantId: number,
  asset: string,
  network: string,
  quoteAsset: string,
): Promise<RateRow | null> {
  return withTenant(db, tenantId, async (tx) => {
    // Точное совпадение по сети, затем fallback на network=''.
    for (const net of network ? [network, ""] : [""]) {
      const [row] = await tx
        .select({
          id: exchangeRates.id,
          baseRate: exchangeRates.baseRate,
          quoteMode: exchangeRates.quoteMode,
          marginPct: exchangeRates.marginPct,
          feeFixedThb: exchangeRates.feeFixedThb,
          minAmountFrom: exchangeRates.minAmountFrom,
          maxAmountFrom: exchangeRates.maxAmountFrom,
        })
        .from(exchangeRates)
        .where(
          and(
            eq(exchangeRates.tenantId, tenantId),
            eq(exchangeRates.asset, asset),
            eq(exchangeRates.quoteAsset, quoteAsset),
            eq(exchangeRates.network, net),
            eq(exchangeRates.isActive, true),
          ),
        )
        .limit(1);
      if (row) {
        return {
          id: row.id,
          baseRate: Number(row.baseRate),
          quoteMode: row.quoteMode,
          marginPct: Number(row.marginPct),
          feeFixedThb: Number(row.feeFixedThb),
          minAmountFrom: row.minAmountFrom === null ? null : Number(row.minAmountFrom),
          maxAmountFrom: row.maxAmountFrom === null ? null : Number(row.maxAmountFrom),
        };
      }
    }
    return null;
  });
}

async function findActiveTierRows(
  db: Db,
  tenantId: number,
  asset: string,
  network: string,
  quoteAsset: string,
): Promise<TierRow[]> {
  return withTenant(db, tenantId, async (tx) => {
    for (const net of network ? [network, ""] : [""]) {
      const rows = await tx
        .select({
          marketRate: exchangeRateTiers.marketRate,
          displayRate: exchangeRateTiers.displayRate,
          deviationPct: exchangeRateTiers.deviationPct,
          minAmount: exchangeRateTiers.minAmount,
          maxAmount: exchangeRateTiers.maxAmount,
        })
        .from(exchangeRateTiers)
        .where(
          and(
            eq(exchangeRateTiers.tenantId, tenantId),
            eq(exchangeRateTiers.asset, asset),
            eq(exchangeRateTiers.quoteAsset, quoteAsset),
            eq(exchangeRateTiers.network, net),
            eq(exchangeRateTiers.rangeBasis, "target_thb"),
            eq(exchangeRateTiers.isActive, true),
          ),
        )
        .orderBy(asc(exchangeRateTiers.minAmount));
      if (rows.length > 0) {
        return rows.map((row) => ({
          marketRate: Number(row.marketRate),
          displayRate: Number(row.displayRate),
          deviationPct: Number(row.deviationPct),
          minAmount: Number(row.minAmount),
          maxAmount: row.maxAmount === null ? null : Number(row.maxAmount),
        }));
      }
    }
    return [];
  });
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Считает котировку. Чистая функция поверх активного курса тенанта.
 * Возвращает QuoteError при отсутствии курса, неположительной сумме или
 * нарушении лимитов (min/max).
 */
export async function computeQuote(
  db: Db,
  tenantId: number,
  input: {
    asset: string;
    network?: string | null;
    amount: number;
    amountMode?: "source_amount" | "target_thb";
  },
  guardrails?: ExchangeGuardrails,
): Promise<QuoteResult | QuoteError> {
  const asset = normAsset(input.asset);
  const amount = Number(input.amount);
  const amountMode = input.amountMode === "target_thb" ? "target_thb" : "source_amount";
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Сумма должна быть положительным числом." };
  }
  const network = resolveNetwork(asset, input.network);
  const currency = await getTenantQuoteCurrency(db, tenantId);

  const row = await findActiveRateRow(db, tenantId, asset, network, currency.code);
  if (!row) {
    return {
      ok: false,
      error: `Курс для ${asset}${network ? ` (${network.toUpperCase()})` : ""} не настроен. Нужен оператор.`,
    };
  }

  if (amountMode === "source_amount" && row.minAmountFrom !== null && amount < row.minAmountFrom) {
    return { ok: false, error: `Минимальная сумма обмена — ${row.minAmountFrom} ${asset}.` };
  }
  if (amountMode === "source_amount" && row.maxAmountFrom !== null && amount > row.maxAmountFrom) {
    return { ok: false, error: `Максимальная сумма обмена — ${row.maxAmountFrom} ${asset}.` };
  }

  const mode = row.quoteMode === "divide" ? "divide" : "multiply";
  const tiers = await findActiveTierRows(db, tenantId, asset, network, currency.code);
  const marketGross = amountMode === "target_thb"
    ? amount
    : mode === "divide"
      ? amount / row.baseRate
      : amount * row.baseRate;
  const tier = tiers.find((candidate) =>
    marketGross >= candidate.minAmount
    && (candidate.maxAmount === null || marketGross < candidate.maxAmount),
  );
  const eff = tier
    ? tier.displayRate
    : mode === "divide"
      ? row.baseRate * (1 + row.marginPct / 100)
      : row.baseRate * (1 - row.marginPct / 100);

  // Guardrail: блокируем неадекватную/убыточную котировку. Срабатывает и для
  // tier.displayRate — он раньше обходил любые проверки (кейс «10 вместо 35»).
  const guard = checkRateGuard({ eff, baseRate: row.baseRate, mode, guardrails });
  if (guard.tripped) {
    return { ok: false, error: "Некорректный курс. Нужен оператор.", guard };
  }

  const amountFrom = amountMode === "target_thb"
    ? mode === "divide"
      ? Math.ceil((amount + row.feeFixedThb) * eff)
      : round((amount + row.feeFixedThb) / eff, 6)
    : amount;

  if (row.minAmountFrom !== null && amountFrom < row.minAmountFrom) {
    return { ok: false, error: `Минимальная сумма обмена — ${row.minAmountFrom} ${asset}.` };
  }
  if (row.maxAmountFrom !== null && amountFrom > row.maxAmountFrom) {
    return { ok: false, error: `Максимальная сумма обмена — ${row.maxAmountFrom} ${asset}.` };
  }

  const gross = mode === "divide" ? amountFrom / eff : amountFrom * eff;
  const amountToThb = amountMode === "target_thb"
    ? Math.round(amount)
    : Math.max(0, Math.round(gross - row.feeFixedThb));

  return {
    ok: true,
    direction: `${asset}->${currency.code}`,
    asset,
    quoteAsset: currency.code,
    network: network.toUpperCase(),
    amountMode,
    amountFrom,
    rate: round(eff, 6),
    quoteMode: mode,
    amountToThb,
    marginPct: tier ? tier.deviationPct : row.marginPct,
    feeFixedThb: row.feeFixedThb,
  };
}
