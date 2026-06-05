import { InfoIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ApiError,
  clearToken,
  type ExchangeOrder,
  type ExchangeRate,
  type ExchangeTurnover,
  type FunnelAnalytics,
  saas,
} from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type BadgeVariant = "default" | "secondary" | "success" | "warning" | "destructive" | "outline";

const ORDER_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  quote: { label: "Котировка", variant: "secondary" },
  awaiting_payment: { label: "Ждёт оплату", variant: "warning" },
  paid: { label: "Оплачено", variant: "default" },
  payout: { label: "Выдача", variant: "default" },
  completed: { label: "Завершено", variant: "success" },
  cancelled: { label: "Отменено", variant: "destructive" },
  expired: { label: "Истекло", variant: "destructive" },
};
const STATUS_ORDER = Object.keys(ORDER_STATUS);
const OPEN_STATUSES = ["quote", "awaiting_payment", "paid", "payout"];

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
  thai_bank_transfer: "Тайский банк",
  atm: "ATM",
};

const PERIODS = [
  ["7", "7 дней"],
  ["30", "30 дней"],
  ["90", "90 дней"],
  ["all", "Всё"],
] as const;
type Period = (typeof PERIODS)[number][0];

function fmtMoney(n: number): string {
  return Math.round(n || 0).toLocaleString("ru-RU");
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
  accent = "bg-primary/70",
}: {
  label: React.ReactNode;
  value: number;
  max: number;
  right: React.ReactNode;
  accent?: string;
}) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3 py-1.5 text-sm">
      <span className="w-32 shrink-0 truncate">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${accent}`} style={{ width: `${width}%` }} />
      </div>
      <span className="w-28 shrink-0 text-right tabular-nums text-muted-foreground">{right}</span>
    </div>
  );
}

export function SaasAnalytics() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<ExchangeOrder[]>([]);
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [turnover, setTurnover] = useState<ExchangeTurnover | null>(null);
  const [funnel, setFunnel] = useState<FunnelAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>("30");
  const [currency, setCurrency] = useState("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [o, t, r, f] = await Promise.all([
          saas.exchangeOrders(undefined, 500),
          saas.exchangeTurnover(),
          saas.exchangeRates(),
          saas.getFunnelAnalytics().catch(() => null),
        ]);
        if (cancelled) return;
        setOrders(o.orders);
        setTurnover(t);
        setRates(r.rates);
        setFunnel(f);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
          return;
        }
        toast.error("Не удалось загрузить аналитику");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Аналитика" description="Оборот, конверсия, воронка и каналы обмена" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {/* biome-ignore lint/suspicious/noArrayIndexKey: skeleton */}
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Аналитика" description="Оборот, конверсия, воронка и каналы обмена" />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Заявок пока нет — аналитика появится после первых сделок.
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Производные данные ──────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  const periodDays = period === "all" ? 90 : Number(period);
  const periodCutoff = period === "all" ? 0 : now - periodDays * 86400;
  const whenSec = (o: ExchangeOrder) => o.completedAt ?? o.createdAt;

  const currencyOptions = Array.from(
    new Set([...rates.map((r) => r.asset), ...orders.map((o) => o.assetFrom)]),
  ).filter(Boolean);

  const byCurrency = orders.filter((o) => currency === "all" || o.assetFrom === currency);
  const completedInPeriod = byCurrency.filter(
    (o) => o.status === "completed" && whenSec(o) >= periodCutoff,
  );
  const createdInPeriod = byCurrency.filter((o) => o.createdAt >= periodCutoff);
  const openOrders = byCurrency.filter((o) => OPEN_STATUSES.includes(o.status));

  const totalTurnover = completedInPeriod.reduce((s, o) => s + (o.amountToThb || 0), 0);
  const avgTicket = completedInPeriod.length > 0 ? totalTurnover / completedInPeriod.length : 0;
  // Конверсия — по заявкам, и созданным, и завершённым в окне (избегаем >100%).
  const completedAndCreated = completedInPeriod.filter((o) => o.createdAt >= periodCutoff);
  const conversion =
    createdInPeriod.length > 0 ? (completedAndCreated.length / createdInPeriod.length) * 100 : 0;

  // Оценка маржи: amountToThb × marginPct активного курса по активу.
  const marginByAsset = new Map<string, number>();
  for (const r of rates) {
    if (r.isActive && !marginByAsset.has(r.asset)) marginByAsset.set(r.asset, r.marginPct || 0);
  }
  const marginEstimate = completedInPeriod.reduce(
    (s, o) => s + (o.amountToThb || 0) * ((marginByAsset.get(o.assetFrom) ?? 0) / 100),
    0,
  );
  const anyMargin = [...marginByAsset.values()].some((m) => m > 0);

  // График оборота по дням
  const dayBuckets: { key: number; label: string; value: number }[] = [];
  for (let i = periodDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    dayBuckets.push({
      key: Math.floor(d.getTime() / 1000),
      label: d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }),
      value: 0,
    });
  }
  for (const o of completedInPeriod) {
    const d = new Date(whenSec(o) * 1000);
    d.setHours(0, 0, 0, 0);
    const k = Math.floor(d.getTime() / 1000);
    const b = dayBuckets.find((x) => x.key === k);
    if (b) b.value += o.amountToThb || 0;
  }
  const chartMax = Math.max(1, ...dayBuckets.map((b) => b.value));
  const chartEmpty = dayBuckets.every((b) => b.value === 0);

  // По валютам (завершённые)
  const byAsset = new Map<string, { count: number; turnover: number }>();
  for (const o of completedInPeriod) {
    const cur = byAsset.get(o.assetFrom) ?? { count: 0, turnover: 0 };
    cur.count += 1;
    cur.turnover += o.amountToThb || 0;
    byAsset.set(o.assetFrom, cur);
  }
  const assetRows = [...byAsset.entries()]
    .map(([asset, v]) => ({ asset, ...v }))
    .sort((a, b) => b.turnover - a.turnover);

  // По статусам (созданные в окне)
  const statusCounts = STATUS_ORDER.map((s) => ({
    status: s,
    count: createdInPeriod.filter((o) => o.status === s).length,
  })).filter((x) => x.count > 0);
  const statusMax = Math.max(1, ...statusCounts.map((s) => s.count));

  // Способы оплаты / выдачи (завершённые)
  const groupBy = (key: "paymentMethod" | "payoutMethod") => {
    const m = new Map<string, number>();
    for (const o of completedInPeriod) {
      const k = o[key] ?? "—";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([k, count]) => ({ k, count })).sort((a, b) => b.count - a.count);
  };
  const payments = groupBy("paymentMethod");
  const payouts = groupBy("payoutMethod");
  const payMax = Math.max(1, ...payments.map((p) => p.count));
  const payoutMax = Math.max(1, ...payouts.map((p) => p.count));

  // Воронка
  const stages = (funnel?.stages ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((s) => ({ ...s, value: s.leadsEntered || s.leadsCurrent }));
  const useEntered = stages.some((s) => s.leadsEntered > 0);
  const funnelVals = stages.map((s) => (useEntered ? s.leadsEntered : s.leadsCurrent));
  const funnelFirst = Math.max(1, funnelVals[0] ?? 1);
  // Индекс стадии с наибольшим отвалом (по отношению к предыдущей).
  let biggestDrop = -1;
  let biggestDropPct = 0;
  for (let i = 1; i < stages.length; i++) {
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
      <PageHeader title="Аналитика" description="Оборот, конверсия, воронка и каналы обмена" />

      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border p-0.5">
          {PERIODS.map(([v, label]) => (
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

      {/* KPI */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-2xl font-bold tabular-nums">
              {fmtMoney(totalTurnover)}{" "}
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
            <p className="text-2xl font-bold tabular-nums">{pct(Math.min(100, conversion))}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Конверсия (завершено / создано)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-2xl font-bold tabular-nums">{openOrders.length}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Активные заявки</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="flex items-center gap-1.5 text-2xl font-bold tabular-nums">
              {anyMargin ? (
                <>
                  {fmtMoney(marginEstimate)}{" "}
                  <span className="text-sm font-normal text-muted-foreground">฿</span>
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <InfoIcon className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">
                  Оценка валовой маржи: сумма по завершённым сделкам × marginPct активного курса
                  актива. Реальная маржа зависит от тиров, отклонения от рынка и комиссий —
                  приблизительно.
                </TooltipContent>
              </Tooltip>
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              Оценка маржи
              {!anyMargin && <span>· задайте маржу в «Обменник»</span>}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* График оборота */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Оборот по дням</CardTitle>
        </CardHeader>
        <CardContent>
          {chartEmpty ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Нет завершённых сделок за период
            </p>
          ) : (
            <>
              <div className="flex h-36 items-end gap-px">
                {dayBuckets.map((b) => (
                  <div
                    key={b.key}
                    className="flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary"
                    style={{ height: `${Math.max(2, (b.value / chartMax) * 100)}%` }}
                    title={`${b.label}: ${fmtMoney(b.value)} ฿`}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
                <span>{dayBuckets[0]?.label}</span>
                <span>пик: {fmtMoney(chartMax)} ฿</span>
                <span>{dayBuckets[dayBuckets.length - 1]?.label}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* По валютам */}
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
                      {fmtMoney(r.turnover)} ฿ · {r.count}
                    </span>
                  }
                />
              ))
            )}
          </CardContent>
        </Card>

        {/* По статусам */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Заявки по статусам</CardTitle>
          </CardHeader>
          <CardContent>
            {statusCounts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Нет заявок за период</p>
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

      {/* Воронка обмена */}
      {stages.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Воронка обмена</CardTitle>
            <p className="text-xs text-muted-foreground">
              По всем заявкам (не зависит от фильтра периода/валюты)
            </p>
          </CardHeader>
          <CardContent className="space-y-1">
            {stages.map((s, i) => {
              const val = funnelVals[i] ?? 0;
              const prev = funnelVals[i - 1] ?? 0;
              const conv = i > 0 && prev > 0 ? (val / prev) * 100 : null;
              const isDrop = i === biggestDrop;
              const terminal =
                s.kind === "terminal_won" ? "✓" : s.kind === "terminal_lost" ? "✗" : "";
              return (
                <div
                  key={s.id}
                  className={`flex items-center gap-3 rounded-md px-2 py-1.5 ${
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
            <div className="flex justify-end gap-3 pt-1 text-[10px] text-muted-foreground">
              <span>вошло · конверсия · ср. дней</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Способы оплаты / выдачи */}
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

      {/* Топ клиентов */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Топ клиентов</CardTitle>
        </CardHeader>
        <CardContent>
          {!turnover || turnover.byContact.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Пока нет клиентов</p>
          ) : (
            <ul className="divide-y">
              {turnover.byContact.slice(0, 15).map((c, idx) => (
                <li
                  key={`${c.contactId ?? "x"}-${c.telegramId ?? "x"}-${idx}`}
                  className="flex items-center justify-between py-2 text-sm first:pt-0 last:pb-0"
                >
                  <span className="truncate">
                    {c.telegramId ? `@${c.telegramId}` : c.contactId ? `#${c.contactId}` : "—"}
                  </span>
                  <span className="flex items-center gap-4 tabular-nums text-muted-foreground">
                    <span>{c.orders} сделок</span>
                    <span className="font-semibold text-foreground">{fmtMoney(c.totalThb)} ฿</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">Топ-50 по обороту (показаны 15).</p>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Аналитика считается по последним 500 заявкам; период «Всё» ограничен этим окном. Маржа —
        оценка.
      </p>
    </div>
  );
}
