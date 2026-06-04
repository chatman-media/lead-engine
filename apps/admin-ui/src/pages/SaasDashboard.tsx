import { AlertTriangleIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

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

function fmtMoney(n: number): string {
  return Math.round(n || 0).toLocaleString("ru-RU");
}

function fmtRate(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
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
      const [t, o, r] = await Promise.all([
        saas.exchangeTurnover(),
        saas.exchangeOrders(),
        saas.exchangeRates(),
      ]);
      setTurnover(t);
      setOrders(o.orders);
      setRates(r.rates);
    } catch {
      // не обменный тенант / нет доступа — секция просто не покажется
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
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
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

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
          </div>

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
        </div>
      )}

      {!isExchange && stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
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
