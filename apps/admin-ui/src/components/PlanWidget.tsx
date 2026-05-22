import { AlertTriangleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ApiError, type BillingPlan, saas, type UsageReport } from "../api/saas.ts";

export interface PlanWidgetProps {
  billing: BillingPlan;
  stripeEnabled?: boolean;
  onRefresh?: () => void;
}

function pct(curr: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.round((curr / max) * 100));
}

function Meter({ label, current, max }: { label: string; current: number; max: number }) {
  const p = pct(current, max);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {current} / {max}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            p >= 100 ? "bg-destructive" : p >= 80 ? "bg-[var(--warning)]" : "bg-primary",
          )}
          style={{ width: `${p}%` }}
        />
      </div>
    </div>
  );
}

export function PlanWidget({ billing, stripeEnabled = false, onRefresh }: PlanWidgetProps) {
  const { plan, usage, status } = billing;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [llmUsage, setLlmUsage] = useState<UsageReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    void saas
      .getBillingUsage(30)
      .then((u) => {
        if (!cancelled) setLlmUsage(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUpgrade(target: "starter" | "pro") {
    if (!stripeEnabled) return;
    setBusy(true);
    setError("");
    try {
      const res = await saas.createCheckoutSession(target);
      window.location.href = res.url;
    } catch (err) {
      setError(
        err instanceof ApiError ? `Не удалось открыть checkout: ${err.errorCode}` : String(err),
      );
      setBusy(false);
    }
  }

  async function handlePortal() {
    if (!stripeEnabled) return;
    setBusy(true);
    setError("");
    try {
      const res = await saas.createBillingPortalSession();
      window.location.href = res.url;
    } catch (err) {
      setError(
        err instanceof ApiError ? `Не удалось открыть портал: ${err.errorCode}` : String(err),
      );
      setBusy(false);
    }
    onRefresh?.();
  }

  const canUpgrade = stripeEnabled && (plan.kind === "free" || plan.kind === "starter");
  const canManage = stripeEnabled && plan.kind !== "free" && plan.kind !== "enterprise";
  const price =
    plan.priceUsd === 0 ? "Бесплатно" : plan.priceUsd === null ? "Custom" : `$${plan.priceUsd}/мес`;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-0.5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Тариф</p>
          <p className="text-lg font-semibold">{plan.label}</p>
          <p className="text-sm text-muted-foreground">{price}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {plan.kind === "free" && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleUpgrade("starter")}
                disabled={!canUpgrade || busy}
                title={!stripeEnabled ? "Stripe не настроен на платформе" : undefined}
              >
                Starter $99
              </Button>
              <Button size="sm" onClick={() => handleUpgrade("pro")} disabled={!canUpgrade || busy}>
                Pro $199
              </Button>
            </>
          )}
          {plan.kind === "starter" && (
            <Button size="sm" onClick={() => handleUpgrade("pro")} disabled={!canUpgrade || busy}>
              Перейти на Pro
            </Button>
          )}
          {canManage && (
            <Button size="sm" variant="outline" onClick={handlePortal} disabled={busy}>
              Управлять
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Meter label="Каналы" current={usage.channels} max={plan.maxChannels} />
        <Meter label="База знаний" current={usage.kbDocuments} max={plan.maxKbDocuments} />

        {llmUsage && (
          <div className="border-t pt-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">LLM-вызовы (месяц)</span>
              <span className="font-mono text-xs tabular-nums">
                {llmUsage.thisMonth.calls.toLocaleString("ru")}
                {llmUsage.thisMonth.errors > 0 ? ` · ${llmUsage.thisMonth.errors} ош.` : ""}
              </span>
            </div>
            {llmUsage.byProvider.length > 0 && (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {llmUsage.byProvider
                  .map((p) => `${p.provider}: ${p.calls.toLocaleString("ru")}`)
                  .join(" · ")}{" "}
                · avg {llmUsage.totals.avgLatencyMs}ms ·{" "}
                {Math.round(llmUsage.totals.successRate * 100)}%
              </p>
            )}
          </div>
        )}

        {status !== "ok" && (
          <p className="flex items-center gap-2 rounded-md border border-[var(--warning)]/40 bg-[color-mix(in_oklch,var(--warning)_12%,transparent)] px-3 py-2 text-sm text-[var(--warning)]">
            <AlertTriangleIcon className="size-4 shrink-0" />
            Лимит превышен ({status === "over_limit_channels" ? "каналы" : "KB документы"}).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
