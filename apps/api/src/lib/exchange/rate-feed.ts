/**
 * Рыночный фид базового курса (base_rate). Тянет рыночную цену asset→котируемая
 * валюта (per-row quote_asset; дефолты — QUOTE_CURRENCY) и отдаёт значение
 * в ориентации quote_mode. Маржа/комиссия НЕ трогаются — это спред обменника
 * поверх рыночного курса.
 *
 * Источники (публичные, без ключей):
 *   - крипта (BTC/ETH): Binance ticker <SYM>USDT → цена в USDT (≈USD);
 *   - FX (USD/RUB/EUR→quote): open.er-api.com/v6/latest/USD → курсы за 1 USD.
 *   USDT принимаем ≈ USD.
 *
 * Точка расширения: RateProvider можно заменить на платный фид/свой источник.
 */

import {
  type Db,
  QUOTE_CURRENCY,
  type QuoteCurrency,
  withTenant,
} from "@chatman-media/conversation-engine";
import {
  exchangeRateProposals,
  exchangeRates,
  exchangeRateTiers,
  exchangeSettings,
  tenants,
} from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";
import { applyRateDeviation } from "./rates.ts";

const FX_API = "https://open.er-api.com/v6/latest/USD";
const BINANCE_TICKER = "https://api.binance.com/api/v3/ticker/price";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Кэш FX на процесс (FX меняется медленно) — TTL 10 мин. */
const FX_TTL_MS = 10 * 60_000;

export type QuoteMode = "multiply" | "divide";

/** Порог sanity-guard рыночного фида (доля). Переопределяется env. */
const FEED_MAX_DEVIATION = (() => {
  const raw = process.env.EXCHANGE_FEED_MAX_DEVIATION;
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0.5;
})();

/**
 * Мягкий порог: до него фид авто-применяется тихо, выше — ставит pending для
 * подтверждения оператором. По умолчанию ~5% — это уровень «заметное колебание».
 * Должен быть строго меньше FEED_MAX_DEVIATION (sanity), иначе теряется граница
 * soft/hard. Переопределяется env `EXCHANGE_FEED_SOFT_DEVIATION`.
 */
const FEED_SOFT_DEVIATION = (() => {
  const raw = process.env.EXCHANGE_FEED_SOFT_DEVIATION;
  const n = raw ? Number(raw) : Number.NaN;
  const v = Number.isFinite(n) && n > 0 ? n : 0.05;
  return Math.min(v, FEED_MAX_DEVIATION);
})();

let fxCache: { at: number; rates: Record<string, number> } | null = null;

async function fetchJson(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Сбрасывает кэш FX-фида. ТОЛЬКО для тестов: разные describe-блоки могут
 * проверять разные FX-наборы (THB-only, PHP+RUB и т.п.), и без сброса
 * кэшированные за прошлый тест курсы провалят последующие фетчи новых валют.
 */
export function __resetFxCacheForTests(): void {
  fxCache = null;
}

/** Курсы валют за 1 USD (включая котируемые, RUB, EUR). С кэшем. */
async function getFxPerUsd(): Promise<Record<string, number>> {
  if (fxCache && Date.now() - fxCache.at < FX_TTL_MS) return fxCache.rates;
  const json = (await fetchJson(FX_API)) as {
    result?: string;
    rates?: Record<string, number>;
  };
  if (json.result !== "success" || !json.rates || Object.keys(json.rates).length === 0) {
    throw new Error("FX feed: bad response");
  }
  fxCache = { at: Date.now(), rates: json.rates };
  return json.rates;
}

async function getBinanceUsdt(symbolBase: string): Promise<number> {
  const json = (await fetchJson(`${BINANCE_TICKER}?symbol=${symbolBase}USDT`)) as {
    price?: string;
  };
  const price = Number(json.price);
  if (!Number.isFinite(price) || price <= 0)
    throw new Error(`Binance: bad price for ${symbolBase}`);
  return price;
}

/**
 * Рыночная цена котируемой валюты за 1 единицу актива (quote per unit).
 * quoteCode — валюта выдачи (per-tenant/per-row); дефолт — платформенный.
 * Возвращает null если актив не поддержан фидом.
 */
export async function fetchMarketQuotePerUnit(
  asset: string,
  quoteCode: string = QUOTE_CURRENCY.code,
): Promise<number | null> {
  const a = asset.trim().toUpperCase();
  const fx = await getFxPerUsd();
  const quotePerUsd = fx[quoteCode] ?? 0;
  if (!(quotePerUsd > 0)) throw new Error(`FX feed: no ${quoteCode}`);

  switch (a) {
    case "USDT":
    case "USD":
      return quotePerUsd;
    case "EUR": {
      const eurPerUsd = fx.EUR ?? 0;
      if (!(eurPerUsd > 0)) return null;
      return quotePerUsd / eurPerUsd; // quote за 1 EUR
    }
    case "RUB": {
      const rubPerUsd = fx.RUB ?? 0;
      if (!(rubPerUsd > 0)) return null;
      return quotePerUsd / rubPerUsd; // quote за 1 RUB
    }
    case "BTC":
      return (await getBinanceUsdt("BTC")) * quotePerUsd;
    case "ETH":
      return (await getBinanceUsdt("ETH")) * quotePerUsd;
    default:
      return null;
  }
}

/** @deprecated Старое THB-имя; считает в платформенной котируемой валюте. */
export const fetchMarketThbPerUnit = fetchMarketQuotePerUnit;

/**
 * Базовый курс в ориентации quote_mode:
 *   multiply → quote за 1 единицу asset;
 *   divide   → единиц asset за 1 quote (1/quotePerUnit).
 * null — если актив не поддержан.
 */
export async function fetchMarketBaseRate(
  asset: string,
  quoteMode: QuoteMode,
  quoteCode: string = QUOTE_CURRENCY.code,
): Promise<number | null> {
  const quotePerUnit = await fetchMarketQuotePerUnit(asset, quoteCode);
  if (quotePerUnit === null || quotePerUnit <= 0) return null;
  return quoteMode === "divide" ? 1 / quotePerUnit : quotePerUnit;
}

/**
 * Проверка адекватности нового курса относительно прежнего. Защита от глюков фида.
 * Если prev>0 и отклонение > maxDeviation (доля) — отклоняем.
 */
export function isRateSane(prev: number, next: number, maxDeviation = FEED_MAX_DEVIATION): boolean {
  if (!Number.isFinite(next) || next <= 0) return false;
  if (!Number.isFinite(prev) || prev <= 0) return true; // первичная установка
  return Math.abs(next - prev) / prev <= maxDeviation;
}

/**
 * Решение фида: что делать с новым курсом относительно прежнего.
 *   - `auto`    — применить тихо (отклонение < soft и тумблер выключен).
 *   - `pending` — поставить предложение оператору (soft ≤ dev ≤ hard ИЛИ
 *                 включён `requireConfirm`).
 *   - `freeze`  — отклонить sanity-guard'ом (dev > hard); прежний курс не
 *                 трогаем + поднимаем pending+rate_anomaly.
 *
 * Чистая функция: ни БД, ни IO. `nextValid` — отдельный флаг негодного next,
 * чтобы вызывающему не пришлось дублировать `isRateSane` для NaN/≤0.
 */
export type RateChangeDecision = "auto" | "pending" | "freeze";

export interface RateChangeClassification {
  decision: RateChangeDecision;
  /** Знаковое отклонение next от prev, доля. NaN если prev ≤ 0. */
  deviation: number;
  /** Подсказка severity для proposals (auto не использует). */
  severity: "soft" | "hard";
  /** false → next невалиден (NaN / ≤0) — вызывающий должен пропустить. */
  nextValid: boolean;
}

export interface RateChangeThresholds {
  /** Мягкий порог (доля). Дефолт — env FEED_SOFT_DEVIATION. */
  soft?: number;
  /** Жёсткий порог (доля). Дефолт — env FEED_MAX_DEVIATION. */
  hard?: number;
  /** Тумблер «требовать подтверждение даже на мелкие тики». */
  requireConfirm?: boolean;
}

export function classifyRateChange(
  prev: number,
  next: number,
  thresholds: RateChangeThresholds = {},
): RateChangeClassification {
  const soft = thresholds.soft ?? FEED_SOFT_DEVIATION;
  const hard = thresholds.hard ?? FEED_MAX_DEVIATION;
  const requireConfirm = thresholds.requireConfirm === true;

  if (!Number.isFinite(next) || next <= 0) {
    return { decision: "auto", deviation: Number.NaN, severity: "soft", nextValid: false };
  }
  if (!Number.isFinite(prev) || prev <= 0) {
    // Первичная установка: применяется тихо (тумблер тут не активируется —
    // нечего сравнивать; pending бессмысленен).
    return { decision: "auto", deviation: Number.NaN, severity: "soft", nextValid: true };
  }
  const deviation = (next - prev) / prev;
  const abs = Math.abs(deviation);
  if (abs > hard) {
    return { decision: "freeze", deviation, severity: "hard", nextValid: true };
  }
  if (abs > soft || requireConfirm) {
    return { decision: "pending", deviation, severity: "soft", nextValid: true };
  }
  return { decision: "auto", deviation, severity: "soft", nextValid: true };
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

/** Резкое отклонение курса от фида, отклонённое sanity-guard'ом. */
export interface RateFeedAnomaly {
  tenantId: number;
  asset: string;
  prev: number;
  next: number;
  /** Отклонение next от prev, % со знаком. */
  deviationPct: number;
}

export interface RateCardTierSpec {
  minThb: number;
  maxThb: number | null;
  /** Absolute public rate to show, e.g. RUB per THB or THB per USDT. */
  displayRate?: number;
  /** Relative adjustment from market rate. RUB: positive worsens for client; USDT: negative worsens. */
  deviationPct?: number;
}

export interface RateCardProposal {
  asset: string;
  network: string;
  quoteMode: QuoteMode;
  marketRate: number;
  tiers: Array<{
    minThb: number;
    maxThb: number | null;
    displayRate: number;
    deviationPct: number;
    formula: string;
  }>;
  message: string;
}

// Дефолтные тиры — под типовое табло обменника (Пхукет). Подобраны как стартовые;
// тенант правит под себя в онбординге/кабинете. Для больших сумм курс выгоднее
// клиенту (RUB/THB ниже, THB/USDT выше), но спред не схлопывается в ноль.
const DEFAULT_RATE_CARD_THB: Record<string, RateCardTierSpec[]> = {
  RUB: [
    { minThb: 2_000, maxThb: 3_000, displayRate: 2.6 },
    { minThb: 3_000, maxThb: 7_000, displayRate: 2.52 },
    { minThb: 7_000, maxThb: 20_000, displayRate: 2.48 },
    { minThb: 20_000, maxThb: 50_000, displayRate: 2.45 },
    { minThb: 50_000, maxThb: null, displayRate: 2.43 },
  ],
  USDT: [
    { minThb: 2_000, maxThb: 10_000, displayRate: 31.4 },
    { minThb: 10_000, maxThb: 100_000, displayRate: 31.5 },
    { minThb: 100_000, maxThb: null, displayRate: 31.7 },
  ],
};

// Для не-THB котируемых валют (PHP и др.) абсолютные THB-курсы не имеют смысла —
// задаём спред относительно рыночного курса (deviationPct), displayRate
// вычислится из живого фида. Диапазоны — в единицах котируемой валюты.
const DEFAULT_RATE_CARD_RELATIVE: Record<string, RateCardTierSpec[]> = {
  RUB: [
    { minThb: 2_000, maxThb: 5_000, deviationPct: 8 },
    { minThb: 5_000, maxThb: 15_000, deviationPct: 5 },
    { minThb: 15_000, maxThb: 40_000, deviationPct: 3.5 },
    { minThb: 40_000, maxThb: 100_000, deviationPct: 2.5 },
    { minThb: 100_000, maxThb: null, deviationPct: 1.5 },
  ],
  USDT: [
    { minThb: 2_000, maxThb: 20_000, deviationPct: -4.5 },
    { minThb: 20_000, maxThb: 200_000, deviationPct: -4 },
    { minThb: 200_000, maxThb: null, deviationPct: -3.5 },
  ],
};

function defaultRateCard(currency: QuoteCurrency): Record<string, RateCardTierSpec[]> {
  return currency.code === "THB" ? DEFAULT_RATE_CARD_THB : DEFAULT_RATE_CARD_RELATIVE;
}

function formatThbRange(min: number, max: number | null, currency: QuoteCurrency): string {
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const word = currency.word;
  if (max === null) return `от${fmt(min)} ${word}`;
  if (min <= 0) return `до ${fmt(max)} ${word}`;
  return `от${fmt(min)} до${fmt(max)} ${word}`;
}

function formatRate(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function rateDeviationPct(marketRate: number, displayRate: number, dp = 4): number {
  return round(((displayRate - marketRate) / marketRate) * 100, dp);
}

export function renderRateCardMessage(
  proposals: RateCardProposal[],
  currency: QuoteCurrency = QUOTE_CURRENCY,
): string {
  const rub = proposals.find((p) => p.asset === "RUB");
  const usdt = proposals.find((p) => p.asset === "USDT");
  const lines = ["🙏 АКТУАЛЬНЫЙ КУРС НА СЕГОДНЯ 🙏", ""];

  if (rub) {
    rub.tiers.forEach((tier, idx) => {
      const marker = idx === 0 ? ">" : idx === 1 ? "-" : "<";
      lines.push(
        `🇷🇺RUB // ${currency.tabloWord} - ${formatRate(tier.displayRate)} ${marker} (${formatThbRange(tier.minThb, tier.maxThb, currency)}${currency.flag}`,
      );
    });
    lines.push("***", "", "🏪💲———💳💳 💰 💳💳———💲🏪", "");
  }

  if (usdt) {
    usdt.tiers.forEach((tier) => {
      lines.push(
        `💲USDT // ${currency.tabloWord} < ${formatRate(tier.displayRate)} - (${formatThbRange(tier.minThb, tier.maxThb, currency)})${currency.flag}`,
      );
    });
    lines.push(
      "",
      "💲💲💲💲💲💲без карты(Инструкция)",
      "",
      "📞 LINE",
      "📞 WhatsApp",
      "📞 WeChat",
      "",
      "💬Отзывы о Нашей Работе 📨",
    );
  }

  return lines.join("\n");
}

export async function buildDefaultRateCardProposal(
  currency: QuoteCurrency = QUOTE_CURRENCY,
): Promise<RateCardProposal[]> {
  const assets: Array<{
    asset: "RUB" | "USDT";
    quoteMode: QuoteMode;
    network: string;
  }> = [
    { asset: "RUB", quoteMode: "divide", network: "" },
    { asset: "USDT", quoteMode: "multiply", network: "trc20" },
  ];

  const proposals: RateCardProposal[] = [];
  for (const item of assets) {
    const marketRateRaw = await fetchMarketBaseRate(item.asset, item.quoteMode, currency.code);
    if (marketRateRaw === null) continue;
    const marketRate = round(marketRateRaw, 6);
    const spec = defaultRateCard(currency)[item.asset] ?? [];
    const tiers = spec.map((tier) => {
      const displayRate = round(
        tier.displayRate ?? marketRate * (1 + (tier.deviationPct ?? 0) / 100),
        6,
      );
      const deviation = rateDeviationPct(marketRate, displayRate);
      return {
        minThb: tier.minThb,
        maxThb: tier.maxThb,
        displayRate,
        deviationPct: deviation,
        formula: `${formatRate(marketRate)} ${deviation >= 0 ? "+" : "-"} ${formatRate(Math.abs(deviation))}% = ${formatRate(displayRate)}`,
      };
    });
    proposals.push({
      asset: item.asset,
      network: item.network,
      quoteMode: item.quoteMode,
      marketRate,
      tiers,
      message: "",
    });
  }
  const message = renderRateCardMessage(proposals, currency);
  return proposals.map((p) => ({ ...p, message }));
}

/**
 * Применяет новый base_rate к строке exchange_rates и пересчитывает тиры по
 * сохранённому deviationPct (display_rate = base × (1 + dev/100), формат как
 * в approve-пути). Используется фидом (refreshTenantRates) и при подтверждении
 * pending-предложения (admin-exchange.ts) — общий код, чтобы публичная rate-card
 * не разошлась с базой.
 *
 * Вызывать ВНУТРИ существующей withTenant-транзакции — RLS должен быть выставлен
 * вызывающим. tx — drizzle-транзакция тенанта.
 */
export async function applyBaseRateToTiers(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: number,
  spec: {
    rateId?: number;
    asset: string;
    quoteAsset: string;
    network: string;
    quoteMode: string;
    baseRate: number;
  },
  nowSec: number,
): Promise<void> {
  const quoteMode = spec.quoteMode === "divide" ? "divide" : "multiply";
  const newBase = round(spec.baseRate);

  if (spec.rateId !== undefined) {
    await tx
      .update(exchangeRates)
      .set({ baseRate: newBase, updatedAt: nowSec })
      .where(and(eq(exchangeRates.tenantId, tenantId), eq(exchangeRates.id, spec.rateId)));
  } else {
    await tx
      .update(exchangeRates)
      .set({ baseRate: newBase, updatedAt: nowSec })
      .where(
        and(
          eq(exchangeRates.tenantId, tenantId),
          eq(exchangeRates.asset, spec.asset),
          eq(exchangeRates.quoteAsset, spec.quoteAsset),
          eq(exchangeRates.network, spec.network),
        ),
      );
  }

  const tiers = await tx
    .select({
      id: exchangeRateTiers.id,
      deviationPct: exchangeRateTiers.deviationPct,
    })
    .from(exchangeRateTiers)
    .where(
      and(
        eq(exchangeRateTiers.tenantId, tenantId),
        eq(exchangeRateTiers.asset, spec.asset),
        eq(exchangeRateTiers.quoteAsset, spec.quoteAsset),
        eq(exchangeRateTiers.network, spec.network),
      ),
    );
  for (const tier of tiers) {
    const deviation = Number(tier.deviationPct);
    const displayRate = round(applyRateDeviation(newBase, deviation));
    await tx
      .update(exchangeRateTiers)
      .set({
        marketRate: newBase,
        displayRate,
        formulaJson: JSON.stringify({
          source: "market_deviation",
          quoteMode,
          marketRate: newBase,
          displayRate,
          deviationPct: deviation,
        }),
        updatedAt: nowSec,
      })
      .where(and(eq(exchangeRateTiers.tenantId, tenantId), eq(exchangeRateTiers.id, tier.id)));
  }
}

/**
 * Pending-предложение фида: upsert по partial-unique (tenant_id, asset,
 * quote_asset, network) WHERE status='pending' — последний выигрывает, старый
 * pending перетирается (это «схлопывание»). Вызывать в withTenant.
 */
export interface RateProposalSpec {
  rateId?: number;
  asset: string;
  quoteAsset: string;
  network: string;
  quoteMode: string;
  prevBaseRate: number;
  nextBaseRate: number;
  /** Знаковая доля, как из classifyRateChange. Конвертируется в проценты для БД. */
  deviation: number;
  severity: "soft" | "hard";
}

export async function upsertRateProposal(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: number,
  spec: RateProposalSpec,
  nowSec: number,
): Promise<void> {
  const quoteMode = spec.quoteMode === "divide" ? "divide" : "multiply";
  const deviationPct = round(spec.deviation * 100, 6);
  await tx
    .insert(exchangeRateProposals)
    .values({
      tenantId,
      rateId: spec.rateId ?? null,
      asset: spec.asset,
      quoteAsset: spec.quoteAsset,
      network: spec.network,
      quoteMode,
      prevBaseRate: spec.prevBaseRate,
      nextBaseRate: round(spec.nextBaseRate),
      deviationPct,
      severity: spec.severity,
      status: "pending",
      source: "feed",
      createdAt: nowSec,
      updatedAt: nowSec,
    })
    // partial-unique поверх (tenant_id,asset,quote_asset,network) WHERE status='pending':
    // upsert через target+where перетирает существующий pending новым снапшотом.
    .onConflictDoUpdate({
      target: [
        exchangeRateProposals.tenantId,
        exchangeRateProposals.asset,
        exchangeRateProposals.quoteAsset,
        exchangeRateProposals.network,
      ],
      targetWhere: sql`status = 'pending'`,
      set: {
        rateId: spec.rateId ?? null,
        quoteMode,
        prevBaseRate: spec.prevBaseRate,
        nextBaseRate: round(spec.nextBaseRate),
        deviationPct,
        severity: spec.severity,
        updatedAt: nowSec,
      },
    });
}

/** Резкое (sanity-guard tripped) колебание + поставленное pending — для уведомлений. */
export interface RateProposalEvent {
  tenantId: number;
  asset: string;
  quoteAsset: string;
  network: string;
  prev: number;
  next: number;
  /** Знаковое отклонение, %. */
  deviationPct: number;
  severity: "soft" | "hard";
}

/**
 * Обновляет base_rate всех auto-строк тенанта рыночным курсом. HTTP-фетчи делаются
 * ВНЕ транзакции (FX кэшируется), запись — короткой транзакцией. margin/fee не трогаем.
 *
 * Поведение по порогам (см. classifyRateChange):
 *   - `auto`    — применяем как раньше (быстрый путь).
 *   - `pending` — base_rate НЕ меняем, кладём предложение в exchange_rate_proposals.
 *   - `freeze`  — sanity-guard'ом отклоняем + поднимаем rate_anomaly (как раньше)
 *                 + кладём pending, чтобы был управляемый путь применить.
 */
export async function refreshTenantRates(
  db: Db,
  tenantId: number,
  log?: { warn?: (msg: string) => void },
  onAnomaly?: (a: RateFeedAnomaly) => void,
  onProposal?: (p: RateProposalEvent) => void,
): Promise<RefreshResult> {
  const { rows, requireConfirm } = await withTenant(db, tenantId, async (tx) => {
    const fetched = await tx
      .select({
        id: exchangeRates.id,
        asset: exchangeRates.asset,
        quoteAsset: exchangeRates.quoteAsset,
        network: exchangeRates.network,
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
      );
    const [settings] = await tx
      .select({ requireRateConfirmation: exchangeSettings.requireRateConfirmation })
      .from(exchangeSettings)
      .where(eq(exchangeSettings.tenantId, tenantId))
      .limit(1);
    return { rows: fetched, requireConfirm: settings?.requireRateConfirmation === true };
  });

  const result: RefreshResult = { updated: 0, skipped: 0, failed: 0 };
  if (rows.length === 0) return result;

  type Update = {
    id: number;
    asset: string;
    quoteAsset: string;
    network: string;
    quoteMode: string;
    baseRate: number;
  };
  type Pending = { spec: RateProposalSpec; event: RateProposalEvent };

  const updates: Update[] = [];
  const pending: Pending[] = [];
  for (const row of rows) {
    try {
      const next = await fetchMarketBaseRate(
        row.asset,
        row.quoteMode === "divide" ? "divide" : "multiply",
        row.quoteAsset,
      );
      if (next === null) {
        result.skipped++;
        continue;
      }
      const prev = Number(row.baseRate);
      const decision = classifyRateChange(prev, next, { requireConfirm });
      if (!decision.nextValid) {
        result.skipped++;
        continue;
      }
      const deviationPct = Number.isFinite(decision.deviation)
        ? decision.deviation * 100
        : Number.NaN;
      if (decision.decision === "freeze") {
        result.skipped++;
        log?.warn?.(`rate-feed: ${row.asset} отклонён sanity-guard (prev=${prev}, next=${next})`);
        // Резкое колебание курса — поднимаем аномалию (доставку владельцу делает #145).
        onAnomaly?.({ tenantId, asset: row.asset, prev, next, deviationPct });
        // …и кладём pending, чтобы у оператора был управляемый путь применить.
        pending.push({
          spec: {
            rateId: row.id,
            asset: row.asset,
            quoteAsset: row.quoteAsset,
            network: row.network,
            quoteMode: row.quoteMode,
            prevBaseRate: prev,
            nextBaseRate: next,
            deviation: decision.deviation,
            severity: "hard",
          },
          event: {
            tenantId,
            asset: row.asset,
            quoteAsset: row.quoteAsset,
            network: row.network,
            prev,
            next,
            deviationPct,
            severity: "hard",
          },
        });
        continue;
      }
      if (decision.decision === "pending") {
        result.skipped++;
        pending.push({
          spec: {
            rateId: row.id,
            asset: row.asset,
            quoteAsset: row.quoteAsset,
            network: row.network,
            quoteMode: row.quoteMode,
            prevBaseRate: prev,
            nextBaseRate: next,
            deviation: decision.deviation,
            severity: "soft",
          },
          event: {
            tenantId,
            asset: row.asset,
            quoteAsset: row.quoteAsset,
            network: row.network,
            prev,
            next,
            deviationPct,
            severity: "soft",
          },
        });
        continue;
      }
      updates.push({
        id: row.id,
        asset: row.asset,
        quoteAsset: row.quoteAsset,
        network: row.network,
        quoteMode: row.quoteMode,
        baseRate: round(next),
      });
    } catch (err) {
      result.failed++;
      log?.warn?.(
        `rate-feed: ${row.asset} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (updates.length > 0 || pending.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    await withTenant(db, tenantId, async (tx) => {
      for (const u of updates) {
        await applyBaseRateToTiers(
          tx,
          tenantId,
          {
            rateId: u.id,
            asset: u.asset,
            quoteAsset: u.quoteAsset,
            network: u.network,
            quoteMode: u.quoteMode,
            baseRate: u.baseRate,
          },
          now,
        );
      }
      for (const p of pending) {
        await upsertRateProposal(tx, tenantId, p.spec, now);
      }
    });
    result.updated = updates.length;
    // Уведомление о pending — НЕ critical (partial-unique уже дедуплицирует
    // дубли). Шлём после успешного upsert'a.
    for (const p of pending) onProposal?.(p.event);
  }
  return result;
}

/** Обновляет курсы всех активных тенантов (для планового фида). */
export async function refreshAllActiveTenants(
  db: Db,
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void },
  onAnomaly?: (a: RateFeedAnomaly) => void,
  onProposal?: (p: RateProposalEvent) => void,
): Promise<void> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  for (const { id } of rows) {
    try {
      const r = await refreshTenantRates(db, id, log, onAnomaly, onProposal);
      if (r.updated > 0 || r.failed > 0) {
        log?.info?.(
          `rate-feed tenant=${id} updated=${r.updated} skipped=${r.skipped} failed=${r.failed}`,
        );
      }
    } catch (err) {
      log?.warn?.(
        `rate-feed tenant=${id} error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Чистый предикат тик-планировщика: пора ли рефрешить тенанта. */
export function isRefreshDue(
  nowSec: number,
  lastRefreshSec: number | undefined,
  refreshSec: number,
): boolean {
  return nowSec - (lastRefreshSec ?? 0) >= refreshSec;
}

/** Per-tenant интервал рефреша auto-курсов (сек). Нет настройки → defaultSec. */
export async function getTenantRefreshSec(
  db: Db,
  tenantId: number,
  defaultSec: number,
): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    const [s] = await tx
      .select({ rateRefreshSec: exchangeSettings.rateRefreshSec })
      .from(exchangeSettings)
      .where(eq(exchangeSettings.tenantId, tenantId))
      .limit(1);
    return s?.rateRefreshSec ?? defaultSec;
  });
}

export interface DueFeedOpts {
  /** Дефолтный интервал для тенантов без настройки (сек). */
  defaultRefreshSec: number;
  /** Время последнего рефреша per-tenant (epoch sec) — мутируется на месте. */
  lastRefreshByTenant: Map<number, number>;
  /** Текущее время (epoch sec). */
  nowSec: number;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
  onAnomaly?: (a: RateFeedAnomaly) => void;
  /** Pending-предложение поставлено (soft или hard) — для info-уведомления владельцу. */
  onProposal?: (p: RateProposalEvent) => void;
}

/**
 * Тик планировщика курсов: рефрешит auto-курсы тех активных тенантов, у кого
 * подошёл их per-tenant интервал (exchange_settings.rate_refresh_sec, иначе
 * defaultRefreshSec). last-refresh держится в `lastRefreshByTenant` (память
 * процесса) — на рестарте map пуст → рефрешим всех (как прежний boot-прогон).
 */
export async function refreshDueTenants(db: Db, opts: DueFeedOpts): Promise<void> {
  const tenantRows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  for (const { id } of tenantRows) {
    try {
      const refreshSec = await getTenantRefreshSec(db, id, opts.defaultRefreshSec);
      if (!isRefreshDue(opts.nowSec, opts.lastRefreshByTenant.get(id), refreshSec)) {
        continue;
      }
      opts.lastRefreshByTenant.set(id, opts.nowSec);
      const r = await refreshTenantRates(db, id, opts.log, opts.onAnomaly, opts.onProposal);
      if (r.updated > 0 || r.failed > 0) {
        opts.log?.info?.(
          `rate-feed tenant=${id} updated=${r.updated} skipped=${r.skipped} failed=${r.failed}`,
        );
      }
    } catch (err) {
      opts.log?.warn?.(
        `rate-feed tick tenant=${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
