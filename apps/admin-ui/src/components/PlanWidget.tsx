import { useState } from "react";
import { ApiError, type BillingPlan, saas } from "../api/saas.ts";

/**
 * Plan + usage widget на dashboard. Stripe Upgrade / Portal CTA.
 * Если STRIPE_SECRET_KEY не задан на платформе — Upgrade disabled
 * с tooltip "billing not configured".
 */
export interface PlanWidgetProps {
  billing: BillingPlan;
  /** Stripe enabled на платформе (resolved через GET /billing/plans). */
  stripeEnabled?: boolean;
  /** Callback после успешного visit'а Stripe — refresh billing. */
  onRefresh?: () => void;
}

function pct(curr: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.round((curr / max) * 100));
}

function barClass(p: number): string {
  if (p >= 100) return "plan-bar-fill plan-bar-over";
  if (p >= 80) return "plan-bar-fill plan-bar-warn";
  return "plan-bar-fill";
}

export function PlanWidget({ billing, stripeEnabled = false, onRefresh }: PlanWidgetProps) {
  const { plan, usage, status } = billing;
  const chPct = pct(usage.channels, plan.maxChannels);
  const kbPct = pct(usage.kbDocuments, plan.maxKbDocuments);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleUpgrade(target: "starter" | "pro") {
    if (!stripeEnabled) return;
    setBusy(true);
    setError("");
    try {
      const res = await saas.createCheckoutSession(target);
      // Stripe expects a top-level redirect.
      window.location.href = res.url;
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`Не удалось открыть checkout: ${err.errorCode}`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
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
      if (err instanceof ApiError) {
        setError(`Не удалось открыть портал: ${err.errorCode}`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setBusy(false);
    }
    if (onRefresh) onRefresh();
  }

  const canUpgrade = stripeEnabled && (plan.kind === "free" || plan.kind === "starter");
  const canManage = stripeEnabled && plan.kind !== "free" && plan.kind !== "enterprise";

  return (
    <section className="plan-widget">
      <div className="plan-widget-head">
        <div>
          <h3>
            План: <strong>{plan.label}</strong>
          </h3>
          <small className="muted">
            {plan.priceUsd === 0
              ? "Бесплатно"
              : plan.priceUsd === null
                ? "Custom"
                : `$${plan.priceUsd}/мес`}
          </small>
        </div>
        <div className="plan-actions">
          {plan.kind === "free" && (
            <>
              <button
                type="button"
                className="nav-link"
                onClick={() => handleUpgrade("starter")}
                disabled={!canUpgrade || busy}
                title={!stripeEnabled ? "Stripe не настроен на платформе" : undefined}
              >
                Starter $99
              </button>
              <button
                type="button"
                className="nav-link"
                onClick={() => handleUpgrade("pro")}
                disabled={!canUpgrade || busy}
                title={!stripeEnabled ? "Stripe не настроен на платформе" : undefined}
              >
                Pro $199
              </button>
            </>
          )}
          {plan.kind === "starter" && (
            <button
              type="button"
              className="nav-link"
              onClick={() => handleUpgrade("pro")}
              disabled={!canUpgrade || busy}
            >
              Upgrade Pro
            </button>
          )}
          {canManage && (
            <button
              type="button"
              className="nav-link"
              onClick={handlePortal}
              disabled={busy}
            >
              Управлять
            </button>
          )}
        </div>
      </div>

      {error && <div className="plan-warning">{error}</div>}

      <div className="plan-row">
        <div className="plan-row-label">
          <span>Каналы</span>
          <span className="muted">
            {usage.channels} / {plan.maxChannels}
          </span>
        </div>
        <div className="plan-bar">
          <div className={barClass(chPct)} style={{ width: `${chPct}%` }} />
        </div>
      </div>

      <div className="plan-row">
        <div className="plan-row-label">
          <span>База знаний</span>
          <span className="muted">
            {usage.kbDocuments} / {plan.maxKbDocuments}
          </span>
        </div>
        <div className="plan-bar">
          <div className={barClass(kbPct)} style={{ width: `${kbPct}%` }} />
        </div>
      </div>

      {status !== "ok" && (
        <div className="plan-warning">
          ⚠ Лимит превышен ({status === "over_limit_channels" ? "каналы" : "KB документы"}).
          Удалите неиспользуемое или повысьте план.
        </div>
      )}
    </section>
  );
}
