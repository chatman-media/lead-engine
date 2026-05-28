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

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { exchangeRates } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";

export const QUOTE_ASSET = "THB";
export const CRYPTO_ASSETS = ["USDT", "BTC", "ETH"] as const;

export interface QuoteResult {
  ok: true;
  direction: string; // "USDT->THB"
  asset: string; // "USDT"
  network: string; // "TRC20" | ""
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

async function findActiveRateRow(
  db: Db,
  tenantId: number,
  asset: string,
  network: string,
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
            eq(exchangeRates.quoteAsset, QUOTE_ASSET),
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
  input: { asset: string; network?: string | null; amount: number },
): Promise<QuoteResult | QuoteError> {
  const asset = normAsset(input.asset);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Сумма должна быть положительным числом." };
  }
  const network = resolveNetwork(asset, input.network);

  const row = await findActiveRateRow(db, tenantId, asset, network);
  if (!row) {
    return {
      ok: false,
      error: `Курс для ${asset}${network ? ` (${network.toUpperCase()})` : ""} не настроен. Нужен оператор.`,
    };
  }

  if (row.minAmountFrom !== null && amount < row.minAmountFrom) {
    return { ok: false, error: `Минимальная сумма обмена — ${row.minAmountFrom} ${asset}.` };
  }
  if (row.maxAmountFrom !== null && amount > row.maxAmountFrom) {
    return { ok: false, error: `Максимальная сумма обмена — ${row.maxAmountFrom} ${asset}.` };
  }

  const mode = row.quoteMode === "divide" ? "divide" : "multiply";
  const eff =
    mode === "divide"
      ? row.baseRate * (1 + row.marginPct / 100)
      : row.baseRate * (1 - row.marginPct / 100);
  if (!Number.isFinite(eff) || eff <= 0) {
    return { ok: false, error: "Некорректный курс. Нужен оператор." };
  }

  const gross = mode === "divide" ? amount / eff : amount * eff;
  const amountToThb = Math.max(0, Math.round(gross - row.feeFixedThb));

  return {
    ok: true,
    direction: `${asset}->${QUOTE_ASSET}`,
    asset,
    network: network.toUpperCase(),
    amountFrom: amount,
    rate: round(eff, 6),
    quoteMode: mode,
    amountToThb,
    marginPct: row.marginPct,
    feeFixedThb: row.feeFixedThb,
  };
}
