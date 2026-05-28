/**
 * Рыночный фид базового курса (base_rate). Тянет рыночную цену asset→THB и
 * отдаёт значение в ориентации quote_mode. Маржа/комиссия НЕ трогаются — это
 * спред обменника поверх рыночного курса.
 *
 * Источники (публичные, без ключей):
 *   - крипта (BTC/ETH): Binance ticker <SYM>USDT → цена в USDT (≈USD);
 *   - FX (USD/RUB/EUR→THB): open.er-api.com/v6/latest/USD → курсы за 1 USD.
 *   USDT принимаем ≈ USD.
 *
 * Точка расширения: RateProvider можно заменить на платный фид/свой источник.
 */

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { exchangeRates, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";

const FX_API = "https://open.er-api.com/v6/latest/USD";
const BINANCE_TICKER = "https://api.binance.com/api/v3/ticker/price";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Кэш FX на процесс (FX меняется медленно) — TTL 10 мин. */
const FX_TTL_MS = 10 * 60_000;

export type QuoteMode = "multiply" | "divide";

let fxCache: { at: number; rates: Record<string, number> } | null = null;

async function fetchJson(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Курсы валют за 1 USD (включая THB, RUB, EUR). С кэшем. */
async function getFxPerUsd(): Promise<Record<string, number>> {
  if (fxCache && Date.now() - fxCache.at < FX_TTL_MS) return fxCache.rates;
  const json = (await fetchJson(FX_API)) as { result?: string; rates?: Record<string, number> };
  if (json.result !== "success" || !json.rates?.THB) {
    throw new Error("FX feed: bad response");
  }
  fxCache = { at: Date.now(), rates: json.rates };
  return json.rates;
}

async function getBinanceUsdt(symbolBase: string): Promise<number> {
  const json = (await fetchJson(`${BINANCE_TICKER}?symbol=${symbolBase}USDT`)) as { price?: string };
  const price = Number(json.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Binance: bad price for ${symbolBase}`);
  return price;
}

/**
 * Рыночная цена THB за 1 единицу актива (THB per unit).
 * Возвращает null если актив не поддержан фидом.
 */
export async function fetchMarketThbPerUnit(asset: string): Promise<number | null> {
  const a = asset.trim().toUpperCase();
  const fx = await getFxPerUsd();
  const thbPerUsd = fx.THB ?? 0;
  if (!(thbPerUsd > 0)) throw new Error("FX feed: no THB");

  switch (a) {
    case "USDT":
    case "USD":
      return thbPerUsd;
    case "EUR": {
      const eurPerUsd = fx.EUR ?? 0;
      if (!(eurPerUsd > 0)) return null;
      return thbPerUsd / eurPerUsd; // THB за 1 EUR
    }
    case "RUB": {
      const rubPerUsd = fx.RUB ?? 0;
      if (!(rubPerUsd > 0)) return null;
      return thbPerUsd / rubPerUsd; // THB за 1 RUB
    }
    case "BTC":
      return (await getBinanceUsdt("BTC")) * thbPerUsd;
    case "ETH":
      return (await getBinanceUsdt("ETH")) * thbPerUsd;
    default:
      return null;
  }
}

/**
 * Базовый курс в ориентации quote_mode:
 *   multiply → THB за 1 единицу asset;
 *   divide   → единиц asset за 1 THB (1/thbPerUnit).
 * null — если актив не поддержан.
 */
export async function fetchMarketBaseRate(
  asset: string,
  quoteMode: QuoteMode,
): Promise<number | null> {
  const thbPerUnit = await fetchMarketThbPerUnit(asset);
  if (thbPerUnit === null || thbPerUnit <= 0) return null;
  return quoteMode === "divide" ? 1 / thbPerUnit : thbPerUnit;
}

/**
 * Проверка адекватности нового курса относительно прежнего. Защита от глюков фида.
 * Если prev>0 и отклонение > maxDeviation (доля) — отклоняем.
 */
export function isRateSane(prev: number, next: number, maxDeviation = 0.5): boolean {
  if (!Number.isFinite(next) || next <= 0) return false;
  if (!Number.isFinite(prev) || prev <= 0) return true; // первичная установка
  return Math.abs(next - prev) / prev <= maxDeviation;
}

function round(n: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export interface RefreshResult {
  updated: number;
  skipped: number;
  failed: number;
}

/**
 * Обновляет base_rate всех auto-строк тенанта рыночным курсом. HTTP-фетчи делаются
 * ВНЕ транзакции (FX кэшируется), запись — короткой транзакцией. margin/fee не трогаем.
 */
export async function refreshTenantRates(
  db: Db,
  tenantId: number,
  log?: { warn?: (msg: string) => void },
): Promise<RefreshResult> {
  const rows = await withTenant(db, tenantId, async (tx) =>
    tx
      .select({
        id: exchangeRates.id,
        asset: exchangeRates.asset,
        quoteMode: exchangeRates.quoteMode,
        baseRate: exchangeRates.baseRate,
      })
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.tenantId, tenantId),
          eq(exchangeRates.autoUpdate, true),
          eq(exchangeRates.isActive, true),
        ),
      ),
  );

  const result: RefreshResult = { updated: 0, skipped: 0, failed: 0 };
  if (rows.length === 0) return result;

  const updates: Array<{ id: number; baseRate: number }> = [];
  for (const row of rows) {
    try {
      const next = await fetchMarketBaseRate(row.asset, row.quoteMode === "divide" ? "divide" : "multiply");
      if (next === null) {
        result.skipped++;
        continue;
      }
      if (!isRateSane(Number(row.baseRate), next)) {
        result.skipped++;
        log?.warn?.(`rate-feed: ${row.asset} отклонён sanity-guard (prev=${row.baseRate}, next=${next})`);
        continue;
      }
      updates.push({ id: row.id, baseRate: round(next) });
    } catch (err) {
      result.failed++;
      log?.warn?.(`rate-feed: ${row.asset} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (updates.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    await withTenant(db, tenantId, async (tx) => {
      for (const u of updates) {
        await tx
          .update(exchangeRates)
          .set({ baseRate: u.baseRate, updatedAt: now })
          .where(and(eq(exchangeRates.tenantId, tenantId), eq(exchangeRates.id, u.id)));
      }
    });
    result.updated = updates.length;
  }
  return result;
}

/** Обновляет курсы всех активных тенантов (для планового фида). */
export async function refreshAllActiveTenants(
  db: Db,
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void },
): Promise<void> {
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));
  for (const { id } of rows) {
    try {
      const r = await refreshTenantRates(db, id, log);
      if (r.updated > 0 || r.failed > 0) {
        log?.info?.(`rate-feed tenant=${id} updated=${r.updated} skipped=${r.skipped} failed=${r.failed}`);
      }
    } catch (err) {
      log?.warn?.(`rate-feed tenant=${id} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
