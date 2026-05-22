import type { BillingPlan } from "../api/saas.ts";

/**
 * Plan + usage widget на dashboard. Показывает текущий tier, лимиты,
 * usage-bar'ы. Под Stripe-up'у (M1b) добавит "Upgrade" CTA → checkout.
 */
export interface PlanWidgetProps {
  billing: BillingPlan;
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

export function PlanWidget({ billing }: PlanWidgetProps) {
  const { plan, usage, status } = billing;
  const chPct = pct(usage.channels, plan.maxChannels);
  const kbPct = pct(usage.kbDocuments, plan.maxKbDocuments);

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
        {plan.kind !== "enterprise" && plan.kind !== "pro" && (
          <button type="button" className="nav-link" disabled title="Stripe checkout — M1b">
            Upgrade
          </button>
        )}
      </div>

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
