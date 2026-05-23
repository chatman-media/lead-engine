import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, saas, type UsageReport } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const PURPOSE_LABEL: Record<string, string> = {
  chat: "Диалог (chat)",
  embed: "Эмбеддинги (RAG)",
  vision: "Зрение (OCR / фото)",
  judge: "Судья (judge)",
};

const PERIOD_OPTIONS = [
  { value: 7, label: "7 дней" },
  { value: 30, label: "30 дней" },
  { value: 90, label: "90 дней" },
];

function fmtNum(n: number): string {
  return n.toLocaleString("ru-RU");
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function SaasBilling() {
  const navigate = useNavigate();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [days, setDays] = useState(30);

  function onAuthError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  useEffect(() => {
    setLoading(true);
    setError("");
    saas
      .getBillingUsage(days)
      .then(setReport)
      .catch((err) => {
        if (!onAuthError(err)) setError("Не удалось загрузить статистику");
      })
      .finally(() => setLoading(false));
  }, [days]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <PageHeader
          title="LLM-использование"
          description="Статистика вызовов языковой модели по периоду"
        />
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={days === opt.value ? "default" : "outline"}
              onClick={() => setDays(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {loading && <p className="text-muted-foreground text-sm">Загрузка…</p>}
      {error && <p className="text-destructive text-sm">{error}</p>}

      {report && (
        <>
          {/* Итого за период */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Вызовов за период"
              value={fmtNum(report.totals.calls)}
              sub={`${report.periodDays} дней`}
            />
            <StatCard
              title="Текущий месяц"
              value={fmtNum(report.thisMonth.calls)}
              sub={`ошибок: ${report.thisMonth.errors}`}
            />
            <StatCard
              title="Успешность"
              value={fmtPct(report.totals.successRate)}
              sub={`ошибок: ${fmtNum(report.totals.errors)}`}
              accent={report.totals.successRate < 0.9 ? "destructive" : "default"}
            />
            <StatCard
              title="Ср. задержка"
              value={`${fmtNum(report.totals.avgLatencyMs)} мс`}
              sub="на вызов"
              accent={report.totals.avgLatencyMs > 5000 ? "warning" : "default"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* По назначению */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">По назначению</CardTitle>
              </CardHeader>
              <CardContent>
                {report.byPurpose.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Нет данных</p>
                ) : (
                  <div className="divide-y">
                    {report.byPurpose.map((row) => (
                      <div key={row.purpose} className="flex items-center justify-between py-2">
                        <div>
                          <p className="text-sm font-medium">
                            {PURPOSE_LABEL[row.purpose] ?? row.purpose}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            ошибок: {row.errors} · задержка: {fmtNum(row.avgLatencyMs)} мс
                          </p>
                        </div>
                        <Badge variant="secondary" className="text-xs font-mono">
                          {fmtNum(row.calls)}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* По провайдеру */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">По провайдеру</CardTitle>
              </CardHeader>
              <CardContent>
                {report.byProvider.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Нет данных</p>
                ) : (
                  <div className="divide-y">
                    {report.byProvider.map((row) => {
                      const total = report.totals.calls || 1;
                      const pct = Math.round((row.calls / total) * 100);
                      return (
                        <div key={row.provider} className="py-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium capitalize">{row.provider}</span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {fmtNum(row.calls)} · {pct}%
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-secondary">
                            <div
                              className="h-1.5 rounded-full bg-primary transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  title,
  value,
  sub,
  accent = "default",
}: {
  title: string;
  value: string;
  sub: string;
  accent?: "default" | "destructive" | "warning";
}) {
  const valueClass =
    accent === "destructive"
      ? "text-destructive"
      : accent === "warning"
        ? "text-yellow-600"
        : "";
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs text-muted-foreground font-normal">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-bold tabular-nums ${valueClass}`}>{value}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
      </CardContent>
    </Card>
  );
}
