import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, saas, type SkillItem } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const FAMILY_COLORS: Record<string, string> = {
  cialdini: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  voss: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  nlp: "bg-green-500/10 text-green-600 dark:text-green-400",
  classical: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  custom: "bg-secondary text-secondary-foreground",
};

export function SaasSkills() {
  const navigate = useNavigate();
  const [items, setItems] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    saas
      .listSkills()
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
        } else {
          setError("Не удалось загрузить скилы");
        }
      })
      .finally(() => setLoading(false));
  }, [navigate]);

  const families = [...new Set(items.map((s) => s.family))].sort();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Навыки продаж" description="Список убеждающих техник — используются в промптах стилей" />

      {loading && <p className="text-muted-foreground text-sm">Загрузка…</p>}
      {error && <p className="text-destructive text-sm">{error}</p>}

      {families.map((family) => (
        <div key={family}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {family}
          </h3>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {items
              .filter((s) => s.family === family)
              .map((skill) => (
                <Card key={skill.id} className={skill.isEnabled ? "" : "opacity-50"}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-sm">
                      <span>{skill.displayName}</span>
                      <Badge
                        className={FAMILY_COLORS[skill.family] ?? "bg-secondary text-secondary-foreground"}
                        variant="outline"
                      >
                        {skill.family}
                      </Badge>
                    </CardTitle>
                    <p className="text-xs text-muted-foreground font-mono">{skill.slug}</p>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">{skill.description}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Интент: <span className="font-medium text-foreground">{skill.intent}</span>
                    </p>
                    {!skill.isEnabled && (
                      <Badge variant="outline" className="mt-2 text-xs text-muted-foreground">
                        отключён
                      </Badge>
                    )}
                  </CardContent>
                </Card>
              ))}
          </div>
        </div>
      ))}

      {!loading && items.length === 0 && !error && (
        <p className="text-muted-foreground text-sm">Навыков пока нет. Заполните каталог через seed.</p>
      )}
    </div>
  );
}
