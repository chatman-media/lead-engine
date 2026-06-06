import { MoonIcon, TrendingUpIcon, UserCheckIcon, ZapIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type FunnelPhase, PHASE_ACCENT, PHASE_LABEL } from "@/lib/phases";
import { ApiError, clearToken, type RoiStats, saas } from "../api/saas.ts";

const PERIODS: ReadonlyArray<readonly [number, string]> = [
  [7, "7 дней"],
  [30, "30 дней"],
  [90, "90 дней"],
];

export function SaasRoiDashboard() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(30);
  const [roi, setRoi] = useState<RoiStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const data = await saas.getRoi(period);
        if (!cancelled) setRoi(data);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period, navigate]);

  const funnelMax = Math.max(1, ...(roi?.funnel ?? []).map((p) => p.leads));

  return (
    <div className="space-y-6">
      <PageHeader
        title="ROI — ценность AI"
        description="Сколько работы AI снял с операторов за период"
        actions={
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
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading || !roi ? (
        <div className="space-y-6">
          <Skeleton className="h-28 rounded-xl" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Hero — «спасённые лиды» (ответы вне рабочих часов). Главная цифра
              для кейса/маркетинга: бот работал, пока операторы спали. */}
          <Card className="border-primary/30 bg-[color-mix(in_oklch,var(--primary)_6%,transparent)]">
            <CardContent className="flex items-center gap-4 py-6">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                <MoonIcon className="size-6" />
              </span>
              <div>
                <p className="text-4xl font-bold tabular-nums">{roi.savedLeads}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  лидов получили ответ вне рабочих часов — пока операторы были недоступны
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              icon={<TrendingUpIcon className="size-4" />}
              value={roi.leadsReceived}
              label="Лидов получено"
            />
            <MetricCard
              icon={<ZapIcon className="size-4" />}
              value={roi.fastReply.rate !== null ? `${roi.fastReply.rate}%` : "—"}
              label={`Ответ AI ≤${roi.fastReply.thresholdSeconds}с`}
              hint={
                roi.fastReply.answered > 0
                  ? `${roi.fastReply.within30} из ${roi.fastReply.answered}`
                  : "нет ответов за период"
              }
            />
            <button type="button" onClick={() => navigate("/conversations")} className="text-left">
              <MetricCard
                icon={<UserCheckIcon className="size-4" />}
                value={roi.handoffs}
                label="Передано оператору →"
                accent={roi.handoffs > 0 ? "text-amber-500" : undefined}
              />
            </button>
            <MetricCard
              icon={<TrendingUpIcon className="size-4" />}
              value={roi.conversions.won}
              label="Закрыто (won)"
              hint={roi.conversions.lost > 0 ? `${roi.conversions.lost} отказов` : undefined}
              accent="text-green-500"
            />
          </div>

          {/* Воронка по универсальным фазам костяка */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Воронка по фазам</CardTitle>
              <p className="text-xs text-muted-foreground">
                Текущее распределение лидов (по всем заявкам)
              </p>
            </CardHeader>
            <CardContent className="space-y-1">
              {roi.funnel.every((p) => p.leads === 0) ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Пока нет лидов</p>
              ) : (
                roi.funnel.map((p) => {
                  const phase = p.phase as FunnelPhase;
                  return (
                    <div key={p.phase} className="flex items-center gap-3 py-1 text-sm">
                      <span className="w-28 shrink-0 truncate">
                        {PHASE_LABEL[phase] ?? p.phase}
                      </span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${PHASE_ACCENT[phase] ?? "bg-primary/70"}`}
                          style={{ width: `${Math.max(2, (p.leads / funnelMax) * 100)}%` }}
                        />
                      </div>
                      <span className="w-10 shrink-0 text-right font-semibold tabular-nums">
                        {p.leads}
                      </span>
                    </div>
                  );
                })
              )}
              {roi.unassigned > 0 && (
                <p className="pt-2 text-xs text-muted-foreground">
                  Без фазы: {roi.unassigned} (legacy-лиды без стадии)
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function MetricCard({
  icon,
  value,
  label,
  hint,
  accent,
}: {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  hint?: string;
  accent?: string;
}) {
  return (
    <Card className="h-full transition-colors hover:bg-accent/40">
      <CardContent className="pt-4 pb-3">
        <span className="mb-1.5 flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {icon}
        </span>
        <p className={`text-2xl font-bold tabular-nums ${accent ?? ""}`}>{value}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
        {hint && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{hint}</p>}
      </CardContent>
    </Card>
  );
}
