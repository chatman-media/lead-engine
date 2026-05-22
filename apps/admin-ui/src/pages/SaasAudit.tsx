import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ApiError, type AuditEntry, clearToken, saas } from "../api/saas.ts";

function fmtTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString("ru");
}

const ACTION_LABELS: Record<string, string> = {
  "llm_config.create": "Добавлен LLM конфиг",
  "llm_config.update": "Изменён LLM конфиг",
  "llm_config.delete": "Удалён LLM конфиг",
  "channel.create": "Подключён канал",
  "channel.update": "Обновлён канал",
  "channel.delete": "Отключён канал",
  "channel.error": "Ошибка канала",
  "conversation.reply": "Ответ оператора",
  "conversation.mode.takeover": "Оператор перехватил диалог",
  "conversation.mode.return_to_ai": "AI возвращён в диалог",
  "tenant.pause": "Бот на паузе",
  "tenant.resume": "Бот возобновлён",
  "admin_invite.create": "Создано приглашение",
  "admin_invite.revoke": "Приглашение отозвано",
  "billing.checkout_started": "Начало оплаты",
};

export function SaasAudit() {
  const navigate = useNavigate();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined);

  async function loadInitial() {
    try {
      const res = await saas.listAuditLog({ limit: 50 });
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await saas.listAuditLog({ limit: 50, cursor: nextCursor });
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadInitial();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once
  }, []);

  if (loading) return <p className="text-sm text-muted-foreground">Загрузка…</p>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Аудит-лог"
        description="Кто из администраторов что менял. Запись автоматическая, неизменяемая."
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Пока ничего не происходило
          </CardContent>
        </Card>
      ) : (
        <ol className="relative ml-3 space-y-4 border-l pl-6">
          {items.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[27px] top-1.5 size-2.5 rounded-full border-2 border-background bg-primary" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{ACTION_LABELS[e.action] ?? e.action}</span>
                {e.targetKind && <Badge variant="outline">{e.targetKind}</Badge>}
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {fmtTime(e.createdAt)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {e.adminEmail ?? `admin#${e.adminId ?? "?"}`}
                {e.targetId ? ` · id=${e.targetId}` : ""}
              </p>
              {e.details && (
                <pre className="mt-2 max-h-44 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] text-muted-foreground">
                  {JSON.stringify(e.details, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}

      {nextCursor && (
        <div className="text-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Загрузка…" : "Загрузить ещё"}
          </Button>
        </div>
      )}
    </div>
  );
}
