import { CheckCircle2Icon, MinusCircleIcon, XCircleIcon, ZapIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ApiError, clearToken, type DiagnosticsResult, saas } from "../api/saas.ts";

const CHECK_LABELS: Record<string, string> = {
  "channel.telegram": "Канал",
  "llm.chat": "LLM (chat)",
  "llm.ping": "LLM live ping",
  "llm.embed": "LLM (embed)",
  tenant_secrets: "Шифрование секретов",
};

const STATUS_STYLE: Record<string, { label: string; cls: string; icon: typeof CheckCircle2Icon }> =
  {
    pass: { label: "OK", cls: "text-[var(--success)]", icon: CheckCircle2Icon },
    warn: { label: "WARN", cls: "text-[var(--warning)]", icon: MinusCircleIcon },
    fail: { label: "FAIL", cls: "text-destructive", icon: XCircleIcon },
    skip: { label: "—", cls: "text-muted-foreground", icon: MinusCircleIcon },
  };

export function SaasDiagnostics() {
  const navigate = useNavigate();
  const [result, setResult] = useState<DiagnosticsResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  async function run(live = false) {
    setRunning(true);
    setError("");
    try {
      setResult(await saas.runDiagnostics({ live }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const overall = result?.summary.overall;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Диагностика"
        description="Проверка, что бот настроен: канал + LLM + база знаний. Без отправки сообщений."
        actions={
          <>
            <Button onClick={() => run(false)} disabled={running}>
              {running ? "Проверяем…" : result ? "Перепроверить" : "Запустить проверку"}
            </Button>
            <Button
              variant="outline"
              onClick={() => run(true)}
              disabled={running}
              title="Реальный LLM-вызов (~1 токен)"
            >
              <ZapIcon /> Live ping
            </Button>
          </>
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {!result && !error && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Запустите проверку, чтобы увидеть статус компонентов.
          </CardContent>
        </Card>
      )}

      {result && (
        <div className="space-y-4">
          <div
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium",
              overall === "pass" &&
                "border-[var(--success)]/40 bg-[color-mix(in_oklch,var(--success)_10%,transparent)] text-[var(--success)]",
              overall === "warn" &&
                "border-[var(--warning)]/40 bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] text-[var(--warning)]",
              overall === "fail" && "border-destructive/40 bg-destructive/10 text-destructive",
            )}
          >
            {result.summary.passed} OK
            {result.summary.warned > 0 && `, ${result.summary.warned} WARN`}
            {result.summary.failed > 0 && `, ${result.summary.failed} FAIL`}
            {` из ${result.summary.total}`}
          </div>

          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {result.checks.map((c) => {
                  const s = STATUS_STYLE[c.status] ?? STATUS_STYLE.skip!;
                  const Icon = s.icon;
                  return (
                    <li key={c.name} className="flex items-center gap-3 px-4 py-3">
                      <Icon className={cn("size-5 shrink-0", s.cls)} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{CHECK_LABELS[c.name] ?? c.name}</p>
                        {c.message && (
                          <p className="truncate text-xs text-muted-foreground">{c.message}</p>
                        )}
                      </div>
                      {c.latencyMs !== undefined && (
                        <span className="font-mono text-xs text-muted-foreground">
                          {c.latencyMs}мс
                        </span>
                      )}
                      <span className={cn("text-xs font-semibold", s.cls)}>{s.label}</span>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
