import { AlertTriangleIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { FunnelFlow } from "@/components/FunnelFlow";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type Admin,
  ApiError,
  clearToken,
  type DashboardStats,
  type ExchangeOrder,
  type ExchangeRate,
  type ExchangeTurnover,
  type FunnelAnalytics,
  type FunnelData,
  type LeadListItem,
  type OnboardingStatus,
  saas,
  type TenantInfo,
} from "../api/saas.ts";

/** Приветствие по времени суток. */
function greeting(name: string): string {
  const h = new Date().getHours();
  const part =
    h < 6 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  return name ? `${part}, ${name}!` : `${part}!`;
}

const ORDER_STATUS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "success" | "warning" | "destructive" }
> = {
  quote: { label: "котировка", variant: "secondary" },
  awaiting_payment: { label: "ждёт оплату", variant: "warning" },
  paid: { label: "оплачено", variant: "default" },
  payout: { label: "выдача", variant: "default" },
  completed: { label: "завершено", variant: "success" },
  cancelled: { label: "отменено", variant: "destructive" },
  expired: { label: "истекло", variant: "destructive" },
};

const STATUS_ORDER = Object.keys(ORDER_STATUS);

const PAYMENT_LABEL: Record<string, string> = {
  crypto_transfer: "Crypto",
  sbp_qr: "СБП QR",
  card_transfer: "Карта",
  bank_transfer: "Банк",
  cash: "Наличные",
};
const PAYOUT_LABEL: Record<string, string> = {
  office_cash: "Офис",
  courier_cash: "Курьер",
  cardless_atm: "Cardless ATM",
  thai_bank_transfer: "Перевод на банк",
  atm: "ATM",
};

function fmtMoney(n: number): string {
  return Math.round(n || 0).toLocaleString("ru-RU");
}

function fmtRate(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

/** Горизонтальная строка-бар для распределений (доля от max). */
function BarRow({
  label,
  value,
  max,
  right,
}: {
  label: React.ReactNode;
  value: number;
  max: number;
  right: React.ReactNode;
}) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="grid gap-1.5 py-1.5 text-sm sm:grid-cols-[8rem_minmax(0,1fr)_7rem] sm:items-center sm:gap-3">
      <span className="min-w-0 truncate">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary/70" style={{ width: `${width}%` }} />
      </div>
      <span className="text-right tabular-nums text-muted-foreground">{right}</span>
    </div>
  );
}

export function SaasDashboard() {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [tenantInfo, setTenantInfo] = useState<TenantInfo | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  // Обменник: операционная сводка для главной
  const [turnover, setTurnover] = useState<ExchangeTurnover | null>(null);
  const [orders, setOrders] = useState<ExchangeOrder[]>([]);
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [funnel, setFunnel] = useState<FunnelAnalytics | null>(null);
  const [pipelineFunnel, setPipelineFunnel] = useState<FunnelData | null>(null);
  const [pipelineLeads, setPipelineLeads] = useState<LeadListItem[]>([]);
  const [togglingPause, setTogglingPause] = useState(false);
  const [confirmingPause, setConfirmingPause] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Фильтры операционной сводки + быстрый расчёт
  const [period, setPeriod] = useState<"today" | "7" | "30" | "all">("today");
  const [currency, setCurrency] = useState("all");
  const [estAsset, setEstAsset] = useState("");
  const [estAmount, setEstAmount] = useState("");

  function onAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function refreshOnboarding() {
    try {
      setOnboarding(await saas.onboardingStatus());
    } catch (err) {
      onAuthError(err);
    }
  }
  async function refreshTenantInfo() {
    try {
      const { tenant } = await saas.getTenantInfo();
      setTenantInfo(tenant);
    } catch (err) {
      onAuthError(err);
    }
  }
  // Операционная сводка обменника (эндпоинты включены только у обменных тенантов —
  // у остальных вернут 404, поэтому ошибки молча игнорируем).
  async function refreshExchange() {
    try {
      const [t, o, r, f] = await Promise.all([
        saas.exchangeTurnover(),
        saas.exchangeOrders(undefined, 500),
        saas.exchangeRates(),
        saas.getPrimaryFunnelAnalytics().catch(() => null),
      ]);
      setTurnover(t);
      setOrders(o.orders);
      setRates(r.rates);
      setFunnel(f);
    } catch {
      // не обменный тенант / нет доступа — секция просто не покажется
    }
  }

  async function refreshPipeline() {
    try {
      const funnelRes = await saas.getPrimaryFunnel();
      const leadsRes = await saas.listLeads({
        limit: 120,
        ...(funnelRes.funnel?.id ? { funnelId: funnelRes.funnel.id } : {}),
      });
      setPipelineFunnel(funnelRes);
      setPipelineLeads(leadsRes.items);
    } catch (err) {
      onAuthError(err);
    }
  }

  async function handleTogglePause() {
    if (!tenantInfo) return;
    const newPaused = tenantInfo.status === "active";
    // Пауза — показываем inline-подтверждение вместо confirm()
    if (newPaused && !confirmingPause) {
      setConfirmingPause(true);
      return;
    }
    setConfirmingPause(false);
    setTogglingPause(true);
    setError("");
    try {
      await saas.setTenantPaused(newPaused);
      await refreshTenantInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingPause(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await saas.me();
        if (cancelled) return;
        setAdmin(me.admin);
        await Promise.all([
          refreshOnboarding(),
          refreshTenantInfo(),
          refreshExchange(),
          refreshPipeline(),
          saas
            .getDashboardStats()
            .then(setStats)
            .catch(() => {}),
        ]);
      } catch (err) {
        if (cancelled) return;
        if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
            <Card key={i}>
              <CardContent className="pt-4 pb-3 space-y-2">
                <Skeleton className="h-8 w-12" />
                <Skeleton className="h-3 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    );
  }

  const paused = tenantInfo?.status === "suspended";
  const isExchange = onboarding?.isExchange === true || turnover !== null;
  const escalated = stats?.conversations.escalated ?? 0;
  const activeRates = rates.filter((r) => r.isActive);

  // Валюты для фильтра (активы из курсов + заявок)
  const currencyOptions = Array.from(
    new Set([...rates.map((r) => r.asset), ...orders.map((o) => o.assetFrom)]),
  ).filter(Boolean);

  // Граница периода (unix-сек); "today" — с начала суток.
  const periodCutoff = (() => {
    if (period === "all") return 0;
    if (period === "today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    }
    return Math.floor(Date.now() / 1000) - Number(period) * 86400;
  })();

  const byCurrency = orders.filter((o) => currency === "all" || o.assetFrom === currency);
  const completedInPeriod = byCurrency.filter(
    (o) => o.status === "completed" && o.createdAt >= periodCutoff,
  );
  const periodTurnover = completedInPeriod.reduce((s, o) => s + (o.amountToThb || 0), 0);
  const openOrders = byCurrency.filter((o) =>
    ["quote", "awaiting_payment", "paid", "payout"].includes(o.status),
  );
  const recentOrders = byCurrency.slice(0, 6);

  // Быстрый расчёт ≈ по базовому курсу выбранного актива
  const estRate = activeRates.find((r) => r.asset === (estAsset || activeRates[0]?.asset));
  const estResult = (() => {
    const amt = Number(estAmount);
    if (!estRate || !(amt > 0)) return null;
    const raw = estRate.quoteMode === "divide" ? amt / estRate.baseRate : amt * estRate.baseRate;
    return raw * (1 - (estRate.marginPct || 0) / 100);
  })();

  // Временной ряд оборота: сегодня — по часам, иначе — по дням за период.
  const completedAll = orders.filter(
    (o) => o.status === "completed" && (currency === "all" || o.assetFrom === currency),
  );
  const chartSeries: { label: string; value: number }[] = (() => {
    if (period === "today") {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const startSec = Math.floor(start.getTime() / 1000);
      const buckets = Array.from({ length: 24 }, (_, h) => ({ label: `${h}:00`, value: 0 }));
      for (const o of completedAll) {
        if (o.createdAt >= startSec) {
          const h = new Date(o.createdAt * 1000).getHours();
          buckets[h]!.value += o.amountToThb || 0;
        }
      }
      return buckets;
    }
    const days = period === "7" ? 7 : 30;
    const buckets: { key: number; label: string; value: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      buckets.push({
        key: Math.floor(d.getTime() / 1000),
        label: d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }),
        value: 0,
      });
    }
    for (const o of completedAll) {
      const d = new Date(o.createdAt * 1000);
      d.setHours(0, 0, 0, 0);
      const k = Math.floor(d.getTime() / 1000);
      const b = buckets.find((x) => x.key === k);
      if (b) b.value += o.amountToThb || 0;
    }
    return buckets.map(({ label, value }) => ({ label, value }));
  })();
  const chartMax = Math.max(1, ...chartSeries.map((b) => b.value));
  const chartEmpty = chartSeries.every((b) => b.value === 0);

  // ── Аналитика (доп. метрики и разрезы) ──────────────────────────────
  const avgTicket = completedInPeriod.length > 0 ? periodTurnover / completedInPeriod.length : 0;
  const createdInPeriod = byCurrency.filter((o) => o.createdAt >= periodCutoff);
  const conversion =
    createdInPeriod.length > 0
      ? Math.min(100, (completedInPeriod.length / createdInPeriod.length) * 100)
      : 0;

  // Оценка маржи на сделку: рыночная стоимость отданного актива − выданные THB.
  // Рыночный курс берём из активного rates.baseRate (авто-обновляется). Это
  // оценка (курс на момент сделки мог отличаться) — но осмысленнее marginPct.
  const rateByAsset = new Map<string, ExchangeRate>();
  for (const r of rates) {
    if (r.isActive && !rateByAsset.has(r.asset)) rateByAsset.set(r.asset, r);
  }
  const orderMargin = (o: ExchangeOrder): number | null => {
    const r = rateByAsset.get(o.assetFrom);
    if (!r || !(r.baseRate > 0)) return null;
    const marketThb =
      r.quoteMode === "divide" ? o.amountFrom / r.baseRate : o.amountFrom * r.baseRate;
    return marketThb - (o.amountToThb || 0);
  };

  // По валютам (завершённые в периоде) + маржа по активу
  const assetAgg = new Map<string, { count: number; turnover: number; margin: number }>();
  for (const o of completedInPeriod) {
    const cur = assetAgg.get(o.assetFrom) ?? { count: 0, turnover: 0, margin: 0 };
    cur.count += 1;
    cur.turnover += o.amountToThb || 0;
    const m = orderMargin(o);
    if (m !== null) cur.margin += m;
    assetAgg.set(o.assetFrom, cur);
  }
  const assetRows = [...assetAgg.entries()]
    .map(([asset, v]) => ({ asset, ...v }))
    .sort((a, b) => b.turnover - a.turnover);
  const marginEstimate = assetRows.reduce((s, r) => s + r.margin, 0);
  const marginKnown = completedInPeriod.some((o) => orderMargin(o) !== null);

  // По статусам (созданные в периоде)
  const statusCounts = STATUS_ORDER.map((s) => ({
    status: s,
    count: createdInPeriod.filter((o) => o.status === s).length,
  })).filter((x) => x.count > 0);
  const statusMax = Math.max(1, ...statusCounts.map((s) => s.count));

  // Способы оплаты / выдачи (завершённые)
  const methodAgg = (key: "paymentMethod" | "payoutMethod") => {
    const m = new Map<string, number>();
    for (const o of completedInPeriod) {
      const k = o[key] ?? "—";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([k, count]) => ({ k, count })).sort((a, b) => b.count - a.count);
  };
  const payments = methodAgg("paymentMethod");
  const payouts = methodAgg("payoutMethod");
  const payMax = Math.max(1, ...payments.map((p) => p.count));
  const payoutMax = Math.max(1, ...payouts.map((p) => p.count));

  // Воронка обмена (из funnel/analytics)
  const funnelStages = (funnel?.stages ?? []).slice().sort((a, b) => a.position - b.position);
  const useEntered = funnelStages.some((s) => s.leadsEntered > 0);
  const funnelVals = funnelStages.map((s) => (useEntered ? s.leadsEntered : s.leadsCurrent));
  const funnelFirst = Math.max(1, funnelVals[0] ?? 1);
  let biggestDrop = -1;
  let biggestDropPct = 0;
  for (let i = 1; i < funnelStages.length; i++) {
    const prev = funnelVals[i - 1] ?? 0;
    const cur = funnelVals[i] ?? 0;
    if (prev > 0) {
      const drop = 100 - (cur / prev) * 100;
      if (drop > biggestDropPct) {
        biggestDropPct = drop;
        biggestDrop = i;
      }
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={greeting(admin?.name?.trim() || admin?.email?.split("@")[0] || "")}
        description="Обзор обменника: заявки, диалоги и оборот за сегодня"
        actions={
          tenantInfo && (
            <div className="flex items-center gap-2">
              {confirmingPause && (
                <>
                  <span className="flex items-center gap-1.5 text-sm text-[var(--warning)]">
                    <AlertTriangleIcon className="size-3.5" />
                    Бот замолчит — точно?
                  </span>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleTogglePause}
                    disabled={togglingPause}
                  >
                    Да, пауза
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingPause(false)}>
                    Отмена
                  </Button>
                </>
              )}
              {!confirmingPause && (
                <Button
                  variant={paused ? "default" : "outline"}
                  size="sm"
                  onClick={handleTogglePause}
                  disabled={togglingPause}
                >
                  {paused ? <PlayIcon /> : <PauseIcon />}
                  {paused ? "Возобновить бота" : "Пауза"}
                </Button>
              )}
            </div>
          )
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {paused && (
        <p className="flex items-center gap-2 rounded-lg border border-[var(--warning)]/40 bg-[color-mix(in_oklch,var(--warning)_12%,transparent)] px-4 py-2.5 text-sm text-[var(--warning)]">
          <PauseIcon className="size-4 shrink-0" /> Бот на паузе — сообщения от клиентов не
          обрабатываются.
        </p>
      )}

      {onboarding && <OnboardingChecklist status={onboarding} />}

      <FunnelFlow
        stages={pipelineFunnel?.stages ?? []}
        leads={pipelineLeads}
        analytics={funnel}
        onOpenLead={(leadId) => navigate(`/leads/${leadId}`)}
        onOpenLeads={() => navigate("/leads")}
        onOpenFunnel={() => navigate("/funnel")}
      />

      {/* ── Операционная сводка обменника ────────────────────────── */}
      {isExchange && (
        <div className="space-y-6">
          {/* Фильтры: период оборота + валюта */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border p-0.5">
              {(
                [
                  ["today", "Сегодня"],
                  ["7", "7 дней"],
                  ["30", "30 дней"],
                  ["all", "Всё время"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setPeriod(v)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    period === v
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {currencyOptions.length > 0 && (
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все валюты</SelectItem>
                  {currencyOptions.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-2xl font-bold tabular-nums">
                  {fmtMoney(periodTurnover)}{" "}
                  <span className="text-sm font-normal text-muted-foreground">฿</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">Оборот за период</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-2xl font-bold tabular-nums text-green-500">
                  {completedInPeriod.length}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">Завершено сделок</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-2xl font-bold tabular-nums">
                  {fmtMoney(avgTicket)}{" "}
                  <span className="text-sm font-normal text-muted-foreground">฿</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">Средний чек</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-2xl font-bold tabular-nums">{pct(conversion)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Конверсия (завершено / создано)
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-2xl font-bold tabular-nums">{openOrders.length}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Активные заявки</p>
              </CardContent>
            </Card>
            <button type="button" onClick={() => navigate("/conversations")} className="text-left">
              <Card
                className={
                  escalated > 0
                    ? "border-amber-500/40 transition-colors hover:bg-accent/40"
                    : "transition-colors hover:bg-accent/40"
                }
              >
                <CardContent className="pt-4 pb-3">
                  <p
                    className={`text-2xl font-bold tabular-nums ${escalated > 0 ? "text-amber-500" : ""}`}
                  >
                    {escalated}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Ждут оператора →</p>
                </CardContent>
              </Card>
            </button>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-2xl font-bold tabular-nums">
                  {marginKnown ? (
                    <>
                      {fmtMoney(marginEstimate)}{" "}
                      <span className="text-sm font-normal text-muted-foreground">฿</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Маржа ≈ {!marginKnown && "(нужны курсы)"}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* График оборота за период */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {period === "today" ? "Оборот по часам (сегодня)" : "Оборот по дням"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {chartEmpty ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Нет завершённых сделок за период
                </p>
              ) : (
                <>
                  <div className="flex h-36 items-end gap-px">
                    {chartSeries.map((b, i) => (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: фиксированные бакеты периода
                        key={i}
                        className="flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary"
                        style={{ height: `${Math.max(2, (b.value / chartMax) * 100)}%` }}
                        title={`${b.label}: ${fmtMoney(b.value)} ฿`}
                      />
                    ))}
                  </div>
                  <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
                    <span>{chartSeries[0]?.label}</span>
                    <span>пик: {fmtMoney(chartMax)} ฿</span>
                    <span>{chartSeries[chartSeries.length - 1]?.label}</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Текущие курсы */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base">Текущие курсы</CardTitle>
                <Button size="sm" variant="outline" onClick={() => navigate("/exchange")}>
                  Изменить курсы
                </Button>
              </CardHeader>
              <CardContent>
                {activeRates.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Курсы ещё не настроены —{" "}
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => navigate("/exchange")}
                    >
                      задать
                    </button>
                  </p>
                ) : (
                  <ul className="divide-y">
                    {activeRates.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center justify-between py-2 text-sm first:pt-0 last:pb-0"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-medium">
                            {r.asset}
                            <span className="text-muted-foreground"> → </span>
                            {r.quoteAsset}
                          </span>
                          {r.network && (
                            <span className="font-mono text-xs text-muted-foreground">
                              {r.network}
                            </span>
                          )}
                          {r.autoUpdate && <Badge variant="success">рынок</Badge>}
                        </span>
                        <span className="tabular-nums font-semibold">{fmtRate(r.baseRate)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* Быстрый расчёт (мини-обменник) */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base">Быстрый расчёт</CardTitle>
                <Button size="sm" variant="outline" onClick={() => navigate("/exchange")}>
                  Обменник
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeRates.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Сначала настройте курсы
                  </p>
                ) : (
                  <>
                    <div className="flex items-end gap-2">
                      <div className="flex-1 space-y-1">
                        <span className="text-xs text-muted-foreground">Отдаёт клиент</span>
                        <Select
                          value={estAsset || activeRates[0]?.asset || ""}
                          onValueChange={setEstAsset}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {activeRates.map((r) => (
                              <SelectItem key={r.id} value={r.asset}>
                                {r.asset} → {r.quoteAsset}
                                {r.network ? ` (${r.network})` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex-1 space-y-1">
                        <span className="text-xs text-muted-foreground">Сумма</span>
                        <Input
                          type="number"
                          inputMode="decimal"
                          placeholder="0"
                          value={estAmount}
                          onChange={(e) => setEstAmount(e.target.value)}
                          className="h-9"
                        />
                      </div>
                    </div>
                    <div className="rounded-md bg-muted/40 px-3 py-2.5">
                      <p className="text-xs text-muted-foreground">Клиент получит ≈</p>
                      <p className="text-xl font-bold tabular-nums">
                        {estResult !== null ? `${fmtMoney(estResult)} ${estRate?.quoteAsset}` : "—"}
                      </p>
                      {estRate && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          ориентировочно по базовому курсу {fmtRate(estRate.baseRate)}
                          {estRate.marginPct ? ` − ${estRate.marginPct}% маржа` : ""}
                        </p>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Последние заявки */}
            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base">Последние заявки</CardTitle>
                <Button size="sm" variant="outline" onClick={() => navigate("/exchange")}>
                  Все заявки
                </Button>
              </CardHeader>
              <CardContent>
                {recentOrders.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Заявок пока нет</p>
                ) : (
                  <ul className="divide-y">
                    {recentOrders.map((o) => {
                      const st = ORDER_STATUS[o.status] ?? {
                        label: o.status,
                        variant: "secondary" as const,
                      };
                      return (
                        <li
                          key={o.id}
                          className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0"
                        >
                          <span className="min-w-0">
                            <span className="text-muted-foreground">#{o.id}</span>{" "}
                            <span className="font-medium">
                              {fmtMoney(o.amountFrom)} {o.assetFrom}
                            </span>
                            <span className="text-muted-foreground"> → </span>
                            <span className="tabular-nums">{fmtMoney(o.amountToThb)} ฿</span>
                          </span>
                          <Badge variant={st.variant} className="shrink-0">
                            {st.label}
                          </Badge>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Аналитика: разрезы и воронка ── */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">По валютам</CardTitle>
              </CardHeader>
              <CardContent>
                {assetRows.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Нет завершённых сделок
                  </p>
                ) : (
                  assetRows.map((r) => (
                    <BarRow
                      key={r.asset}
                      label={<span className="font-medium">{r.asset}</span>}
                      value={r.turnover}
                      max={assetRows[0]?.turnover ?? 1}
                      right={
                        <span>
                          {fmtMoney(r.turnover)} ฿
                          {r.margin > 0 && (
                            <span className="text-[var(--success)]">
                              {" "}
                              · +{fmtMoney(r.margin)} маржа
                            </span>
                          )}
                        </span>
                      }
                    />
                  ))
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Заявки по статусам</CardTitle>
              </CardHeader>
              <CardContent>
                {statusCounts.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Нет заявок за период
                  </p>
                ) : (
                  statusCounts.map((s) => (
                    <BarRow
                      key={s.status}
                      label={
                        <Badge variant={ORDER_STATUS[s.status]?.variant ?? "secondary"}>
                          {ORDER_STATUS[s.status]?.label ?? s.status}
                        </Badge>
                      }
                      value={s.count}
                      max={statusMax}
                      right={<span>{s.count}</span>}
                    />
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          {funnelStages.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Воронка обмена</CardTitle>
                <p className="text-xs text-muted-foreground">
                  По всем заявкам (не зависит от фильтра периода/валюты)
                </p>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 overflow-x-auto">
                  {funnelStages.map((s, i) => {
                    const val = funnelVals[i] ?? 0;
                    const prev = funnelVals[i - 1] ?? 0;
                    const conv = i > 0 && prev > 0 ? (val / prev) * 100 : null;
                    const isDrop = i === biggestDrop;
                    const terminal =
                      s.kind === "terminal_won" ? "✓" : s.kind === "terminal_lost" ? "✗" : "";
                    return (
                      <div
                        key={s.id}
                        className={`flex min-w-[38rem] items-center gap-3 rounded-md px-2 py-1.5 ${
                          isDrop ? "border-l-2 border-l-red-500 bg-red-500/5" : ""
                        }`}
                      >
                        <span className="flex w-44 shrink-0 items-center gap-1.5 truncate text-sm">
                          {s.color && (
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: s.color }}
                            />
                          )}
                          <span className="truncate">{s.displayName}</span>
                          {terminal && <span className="text-muted-foreground">{terminal}</span>}
                        </span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary/70"
                            style={{ width: `${Math.max(2, (val / funnelFirst) * 100)}%` }}
                          />
                        </div>
                        <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums">
                          {val}
                        </span>
                        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {conv !== null ? pct(conv) : "—"}
                        </span>
                        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {s.avgDaysInStage !== null ? `${s.avgDaysInStage}д` : "—"}
                        </span>
                        {isDrop && (
                          <Badge variant="destructive" className="shrink-0 text-[10px]">
                            −{Math.round(biggestDropPct)}% отвал
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-end pt-1 text-[10px] text-muted-foreground">
                  вошло · конверсия · ср. дней
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Способы оплаты</CardTitle>
              </CardHeader>
              <CardContent>
                {payments.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Нет данных</p>
                ) : (
                  payments.map((p) => (
                    <BarRow
                      key={p.k}
                      label={PAYMENT_LABEL[p.k] ?? p.k}
                      value={p.count}
                      max={payMax}
                      right={<span>{p.count}</span>}
                    />
                  ))
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Способы выдачи</CardTitle>
              </CardHeader>
              <CardContent>
                {payouts.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Нет данных</p>
                ) : (
                  payouts.map((p) => (
                    <BarRow
                      key={p.k}
                      label={PAYOUT_LABEL[p.k] ?? p.k}
                      value={p.count}
                      max={payoutMax}
                      right={<span>{p.count}</span>}
                    />
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          {turnover && turnover.byContact.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Топ клиентов</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {turnover.byContact.slice(0, 10).map((c, idx) => (
                    <li
                      key={`${c.contactId ?? "x"}-${c.telegramId ?? "x"}-${idx}`}
                      className="flex items-center justify-between py-2 text-sm first:pt-0 last:pb-0"
                    >
                      <span className="truncate">
                        {c.telegramId ? `@${c.telegramId}` : c.contactId ? `#${c.contactId}` : "—"}
                      </span>
                      <span className="flex items-center gap-4 tabular-nums text-muted-foreground">
                        <span>{c.orders} сделок</span>
                        <span className="font-semibold text-foreground">
                          {fmtMoney(c.totalThb)} ฿
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {!isExchange && stats && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold">{stats.leads.total}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Лидов всего</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold text-green-500">
                {stats.leads.byStage
                  .filter((s) => s.kind === "terminal_won")
                  .reduce((sum, s) => sum + s.count, 0)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Закрыто ботом</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold">{stats.conversations.open}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Активных диалогов</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold text-amber-500">{stats.conversations.escalated}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Ждут оператора</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold">{stats.messages.last7days}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Сообщений за 7 дней</p>
            </CardContent>
          </Card>
          {stats.leads.byStage.length > 0 && (
            <div className="col-span-2 sm:col-span-5">
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Лиды по стадиям</p>
                  <div className="flex flex-wrap gap-2">
                    {stats.leads.byStage.map((s) => (
                      <div
                        key={s.slug}
                        className="flex items-center gap-1.5 rounded-md border px-2.5 py-1"
                      >
                        {s.color && (
                          <span
                            className="size-2 rounded-full shrink-0"
                            style={{ backgroundColor: s.color }}
                          />
                        )}
                        <span className="text-xs text-muted-foreground">{s.displayName}</span>
                        <span className="text-xs font-semibold">{s.count}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
