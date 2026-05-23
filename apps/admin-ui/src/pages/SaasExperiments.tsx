import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, saas, type ExperimentItem } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  running: "bg-green-100 text-green-800",
  paused: "bg-yellow-100 text-yellow-800",
  done: "bg-blue-100 text-blue-800",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "черновик",
  running: "идёт",
  paused: "пауза",
  done: "завершён",
};

function formatDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function SaasExperiments() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ExperimentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    saas
      .listExperiments()
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
        } else {
          setError("Не удалось загрузить эксперименты");
        }
      })
      .finally(() => setLoading(false));
  }, [navigate]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="A/B эксперименты"
        description="Сравнение стилей общения по исходу лидов"
      />

      {loading && <p className="text-muted-foreground text-sm">Загрузка…</p>}
      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex flex-col gap-3">
        {items.map((exp) => {
          let allocation: Record<string, number> = {};
          try {
            allocation = JSON.parse(exp.allocationJson) as Record<string, number>;
          } catch {
            // ignore
          }

          return (
            <Card key={exp.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm">
                  <span className="font-mono">{exp.slug}</span>
                  <Badge
                    className={STATUS_BADGE[exp.status] ?? "bg-gray-100 text-gray-800"}
                    variant="outline"
                  >
                    {STATUS_LABEL[exp.status] ?? exp.status}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {Object.entries(allocation).map(([style, pct]) => (
                    <div
                      key={style}
                      className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                    >
                      <span className="font-mono">{style}</span>
                      <span className="text-muted-foreground">{pct}%</span>
                    </div>
                  ))}
                </div>

                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>
                    Метрика: <span className="text-foreground font-medium">{exp.successMetric}</span>
                  </span>
                  {exp.startedAt && (
                    <span>
                      Старт: <span className="text-foreground">{formatDate(exp.startedAt)}</span>
                    </span>
                  )}
                  {exp.endedAt && (
                    <span>
                      Конец: <span className="text-foreground">{formatDate(exp.endedAt)}</span>
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {!loading && items.length === 0 && !error && (
        <p className="text-muted-foreground text-sm">Экспериментов пока нет.</p>
      )}
    </div>
  );
}
