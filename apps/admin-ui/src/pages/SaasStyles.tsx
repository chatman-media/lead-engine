import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, saas, type StyleItem } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SaasStyles() {
  const navigate = useNavigate();
  const [items, setItems] = useState<StyleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    saas
      .listStyles()
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
        } else {
          setError("Не удалось загрузить стили");
        }
      })
      .finally(() => setLoading(false));
  }, [navigate]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Стили общения"
        description="Персоны и продажные фреймворки — единица A/B тестирования"
      />

      {loading && <p className="text-muted-foreground text-sm">Загрузка…</p>}
      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {items.map((style) => {
          let config: Record<string, unknown> = {};
          try {
            config = JSON.parse(style.configJson) as Record<string, unknown>;
          } catch {
            // ignore
          }
          const persona = config.persona as Record<string, unknown> | undefined;
          const framework = config.framework as string | undefined;

          return (
            <Card key={style.id} className={style.isActive ? "" : "opacity-50"}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm">
                  <span>{style.displayName}</span>
                  <div className="flex items-center gap-1.5">
                    {framework && (
                      <Badge variant="secondary" className="text-xs">
                        {framework}
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-xs">
                      v{style.version}
                    </Badge>
                    {!style.isActive && (
                      <Badge variant="outline" className="text-xs text-muted-foreground">
                        неактивен
                      </Badge>
                    )}
                  </div>
                </CardTitle>
                <p className="text-xs text-muted-foreground font-mono">{style.slug}</p>
              </CardHeader>
              <CardContent>
                {persona && (
                  <div className="space-y-1">
                    <p className="text-sm">
                      <span className="text-muted-foreground">Персона: </span>
                      <span className="font-medium">{persona.name as string}</span>
                      {typeof persona.role === "string" && (
                        <span className="text-muted-foreground"> · {persona.role}</span>
                      )}
                    </p>
                    {typeof persona.company === "string" && (
                      <p className="text-xs text-muted-foreground">{persona.company}</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {!loading && items.length === 0 && !error && (
        <p className="text-muted-foreground text-sm">Стилей пока нет.</p>
      )}
    </div>
  );
}
