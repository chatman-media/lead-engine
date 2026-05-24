import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  admins,
  channels,
  kbDocuments,
  llmUsageEvents,
  stripeCustomers,
  tenants,
} from "@chatman-media/storage";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { allPlans, type PlanKind, resolvePlan } from "../lib/plans.ts";
import { StripeApi, StripeApiError, type StripeInvoice, type StripeFetchLike } from "../lib/stripe-api.ts";

/**
 * Per-tenant billing & plan endpoints (M1a — без Stripe).
 *
 * Endpoints:
 *   GET /api/admin/billing/plan      — current plan + limits + usage
 *   GET /api/admin/billing/plans     — список всех доступных plan tier'ов
 *
 * Stripe checkout / portal / webhook live в отдельных endpoints (M1b PR).
 */
export interface AdminBillingRoutesOpts {
  db: Db;
  /**
   * Stripe config — если secretKey пуст, /checkout и /portal вернут 503.
   * priceMap: { starter: "price_...", pro: "price_..." } из env.
   * successUrl / cancelUrl могут содержать placeholder `{TENANT}` —
   * подставляется tenant slug.
   */
  stripe?: {
    secretKey: string;
    priceMap: Partial<Record<PlanKind, string>>;
    successUrl: string;
    cancelUrl: string;
  };
  /** Custom fetch для тестов (intercept'ит Stripe API). */
  fetchImpl?: StripeFetchLike;
}

export function makeAdminBillingRoutes(opts: AdminBillingRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/billing/plan
   * Returns:
   *   {
   *     plan: { kind, label, priceUsd, maxChannels, maxKbDocuments,
   *             rateLimitPerMinute, rateLimitPerHour },
   *     usage: { channels: N, kbDocuments: N },
   *     status: 'ok' | 'over_limit_channels' | 'over_limit_kb'
   *   }
   */
  app.get("/api/admin/billing/plan", async (c) => {
    const tenantId = c.var.tenantId;
    const data = await withTenant(opts.db, tenantId, async (tx) => {
      const [tenant] = await tx
        .select({ plan: tenants.plan })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      const channelRows = await tx
        .select({ value: count() })
        .from(channels)
        .where(eq(channels.tenantId, tenantId));
      const kbRows = await tx
        .select({ value: count() })
        .from(kbDocuments)
        .where(eq(kbDocuments.tenantId, tenantId));
      return {
        plan: tenant?.plan ?? "free",
        channelCount: Number(channelRows[0]?.value ?? 0),
        kbCount: Number(kbRows[0]?.value ?? 0),
      };
    });

    const limits = resolvePlan(data.plan);
    let status: "ok" | "over_limit_channels" | "over_limit_kb" = "ok";
    if (data.channelCount > limits.maxChannels) status = "over_limit_channels";
    else if (data.kbCount > limits.maxKbDocuments) status = "over_limit_kb";

    return c.json({
      plan: {
        kind: data.plan,
        label: limits.label,
        priceUsd: limits.priceUsd,
        maxChannels: limits.maxChannels,
        maxKbDocuments: limits.maxKbDocuments,
        rateLimitPerMinute: limits.rateLimitPerMinute,
        rateLimitPerHour: limits.rateLimitPerHour,
      },
      usage: {
        channels: data.channelCount,
        kbDocuments: data.kbCount,
      },
      status,
    });
  });

  /**
   * GET /api/admin/billing/plans
   * Returns: { plans: [{ kind, label, priceUsd, maxChannels, ... }] }
   *
   * Used by UI plan picker. Без auth-bypass — это per-tenant endpoint.
   */
  app.get("/api/admin/billing/plans", (c) => {
    return c.json({
      plans: allPlans().map(({ kind, limits }) => ({
        kind,
        label: limits.label,
        priceUsd: limits.priceUsd,
        maxChannels: limits.maxChannels,
        maxKbDocuments: limits.maxKbDocuments,
        rateLimitPerMinute: limits.rateLimitPerMinute,
      })),
      stripeEnabled: !!opts.stripe?.secretKey,
    });
  });

  /**
   * POST /api/admin/billing/checkout
   * Body: { plan: 'starter' | 'pro' }
   *
   * Creates a Stripe Checkout Session, returns redirect URL.
   * Flow:
   *  1. Lookup or create Stripe Customer (по tenantId).
   *  2. Map plan → priceId через opts.stripe.priceMap.
   *  3. createCheckoutSession с client_reference_id=tenantId (webhook
   *     handler resolves tenantId назад).
   *  4. recordAudit billing.checkout_started.
   *  5. Return { url } — client делает window.location = url.
   *
   * Errors:
   *   400 — bad plan / plan не имеет stripe price (e.g. enterprise)
   *   404 — admin email/tenant не найден
   *   502 — Stripe API down
   *   503 — Stripe не настроен на платформе (STRIPE_SECRET_KEY пустой)
   */
  app.post("/api/admin/billing/checkout", async (c) => {
    if (!opts.stripe?.secretKey) {
      return c.json({ error: "stripe_not_configured" }, 503);
    }
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId;

    let body: { plan?: unknown };
    try {
      body = (await c.req.json()) as { plan?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const plan = body.plan;
    if (plan !== "starter" && plan !== "pro") {
      return c.json({ error: "plan must be 'starter' or 'pro'" }, 400);
    }
    const priceId = opts.stripe.priceMap[plan];
    if (!priceId) {
      return c.json({ error: `no Stripe price configured for plan ${plan}` }, 400);
    }

    // Lookup tenant + admin email для Stripe Customer.
    const [tenant] = await opts.db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) return c.json({ error: "tenant not found" }, 404);
    const [admin] = await opts.db
      .select({ email: admins.email })
      .from(admins)
      .where(eq(admins.id, adminId));
    if (!admin) return c.json({ error: "admin not found" }, 404);

    const stripe = new StripeApi({
      secretKey: opts.stripe.secretKey,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });

    // Lookup or create Stripe Customer.
    const [existingCust] = await opts.db
      .select({ stripeCustomerId: stripeCustomers.stripeCustomerId })
      .from(stripeCustomers)
      .where(eq(stripeCustomers.tenantId, tenantId));
    let customerId = existingCust?.stripeCustomerId;
    if (!customerId) {
      try {
        const created = await stripe.createCustomer({
          email: admin.email,
          tenantId,
          tenantSlug: tenant.slug,
        });
        customerId = created.id;
        // Persist для последующих checkouts. Webhook handler также insert'ит
        // на customer.created, но мы здесь preempt'им чтобы race не словить.
        const nowEpoch = Math.floor(Date.now() / 1000);
        await opts.db
          .insert(stripeCustomers)
          .values({
            tenantId,
            stripeCustomerId: customerId,
            email: admin.email,
            createdAt: nowEpoch,
            updatedAt: nowEpoch,
          })
          .onConflictDoNothing();
      } catch (err) {
        if (err instanceof StripeApiError) {
          return c.json({ error: "stripe_create_customer_failed", detail: err.message }, 502);
        }
        throw err;
      }
    }

    const successUrl = opts.stripe.successUrl.replace("{TENANT}", tenant.slug);
    const cancelUrl = opts.stripe.cancelUrl.replace("{TENANT}", tenant.slug);

    try {
      const session = await stripe.createCheckoutSession({
        customerId,
        priceId,
        tenantId,
        successUrl,
        cancelUrl,
        trialDays: 14, // ROADMAP M1: 14-day trial
      });
      await recordAudit(opts.db, {
        tenantId,
        adminId,
        action: "billing.checkout_started",
        targetKind: "stripe_checkout",
        targetId: session.id,
        details: { plan, priceId, customerId },
      });
      return c.json({ ok: true, url: session.url, sessionId: session.id });
    } catch (err) {
      if (err instanceof StripeApiError) {
        return c.json({ error: "stripe_checkout_failed", detail: err.message }, 502);
      }
      throw err;
    }
  });

  /**
   * GET /api/admin/billing/usage
   * Optional query: `?days=30` (default 30, max 365)
   *
   * Returns: {
   *   periodDays: 30,
   *   totals: { calls: N, errors: N, successRate: 0.97, avgLatencyMs: N },
   *   byPurpose: [{ purpose, calls, errors, avgLatencyMs }],
   *   byProvider: [{ provider, calls }],
   *   thisMonth: { calls, errors, since (epoch) }
   * }
   *
   * Использует `llm_usage_events` (одна row на каждый LLM call). UI billing
   * dashboard'а показывает summary для BYOK transparency.
   */
  app.get("/api/admin/billing/usage", async (c) => {
    const tenantId = c.var.tenantId;
    const daysRaw = Number.parseInt(c.req.query("days") ?? "30", 10);
    const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 365);
    const sinceEpoch = Math.floor(Date.now() / 1000) - days * 86400;

    // Beginning-of-month boundary для "thisMonth" поля.
    const now = new Date();
    const monthStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0);
    const monthStartEpoch = Math.floor(monthStart.getTime() / 1000);

    const data = await withTenant(opts.db, tenantId, async (tx) => {
      // Totals для period.
      const totalsRows = await tx
        .select({
          calls: count(),
          errors: sql<number>`SUM(CASE WHEN ${llmUsageEvents.success} = false THEN 1 ELSE 0 END)::int`,
          avgLatencyMs: sql<number>`COALESCE(AVG(${llmUsageEvents.latencyMs}), 0)::int`,
        })
        .from(llmUsageEvents)
        .where(
          and(
            eq(llmUsageEvents.tenantId, tenantId),
            gte(llmUsageEvents.createdAt, sinceEpoch),
          ),
        );

      const byPurposeRows = await tx
        .select({
          purpose: llmUsageEvents.purpose,
          calls: count(),
          errors: sql<number>`SUM(CASE WHEN ${llmUsageEvents.success} = false THEN 1 ELSE 0 END)::int`,
          avgLatencyMs: sql<number>`COALESCE(AVG(${llmUsageEvents.latencyMs}), 0)::int`,
        })
        .from(llmUsageEvents)
        .where(
          and(
            eq(llmUsageEvents.tenantId, tenantId),
            gte(llmUsageEvents.createdAt, sinceEpoch),
          ),
        )
        .groupBy(llmUsageEvents.purpose);

      const byProviderRows = await tx
        .select({
          provider: llmUsageEvents.provider,
          calls: count(),
        })
        .from(llmUsageEvents)
        .where(
          and(
            eq(llmUsageEvents.tenantId, tenantId),
            gte(llmUsageEvents.createdAt, sinceEpoch),
          ),
        )
        .groupBy(llmUsageEvents.provider);

      const monthRows = await tx
        .select({
          calls: count(),
          errors: sql<number>`SUM(CASE WHEN ${llmUsageEvents.success} = false THEN 1 ELSE 0 END)::int`,
        })
        .from(llmUsageEvents)
        .where(
          and(
            eq(llmUsageEvents.tenantId, tenantId),
            gte(llmUsageEvents.createdAt, monthStartEpoch),
          ),
        );

      return { totalsRows, byPurposeRows, byProviderRows, monthRows };
    });

    const totals = data.totalsRows[0] ?? { calls: 0, errors: 0, avgLatencyMs: 0 };
    const callsNum = Number(totals.calls);
    const errorsNum = Number(totals.errors ?? 0);
    const monthData = data.monthRows[0] ?? { calls: 0, errors: 0 };

    return c.json({
      periodDays: days,
      totals: {
        calls: callsNum,
        errors: errorsNum,
        successRate: callsNum > 0 ? Number(((callsNum - errorsNum) / callsNum).toFixed(4)) : 1,
        avgLatencyMs: Number(totals.avgLatencyMs),
      },
      byPurpose: data.byPurposeRows.map((r) => ({
        purpose: r.purpose,
        calls: Number(r.calls),
        errors: Number(r.errors ?? 0),
        avgLatencyMs: Number(r.avgLatencyMs),
      })),
      byProvider: data.byProviderRows.map((r) => ({
        provider: r.provider,
        calls: Number(r.calls),
      })),
      thisMonth: {
        calls: Number(monthData.calls),
        errors: Number(monthData.errors ?? 0),
        since: monthStartEpoch,
      },
    });
  });

  /**
   * POST /api/admin/billing/portal
   * Body: { returnUrl?: string } — куда redirect'нуть после.
   *
   * Создаёт Stripe Customer Portal session — tenant сам управляет картой,
   * cancel subscription, etc. Требует существующий stripeCustomers row
   * (т.е. tenant должен был хотя бы раз пройти checkout).
   */
  app.post("/api/admin/billing/portal", async (c) => {
    if (!opts.stripe?.secretKey) {
      return c.json({ error: "stripe_not_configured" }, 503);
    }
    const tenantId = c.var.tenantId;

    let body: { returnUrl?: unknown };
    try {
      body = (await c.req.json().catch(() => ({}))) as { returnUrl?: unknown };
    } catch {
      body = {};
    }
    const [tenant] = await opts.db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) return c.json({ error: "tenant not found" }, 404);

    const [cust] = await opts.db
      .select({ stripeCustomerId: stripeCustomers.stripeCustomerId })
      .from(stripeCustomers)
      .where(eq(stripeCustomers.tenantId, tenantId));
    if (!cust) {
      return c.json(
        { error: "no_stripe_customer", hint: "Start with /checkout first" },
        404,
      );
    }

    const returnUrl =
      typeof body.returnUrl === "string" && body.returnUrl
        ? body.returnUrl
        : (opts.stripe.successUrl || "https://leadengine.app/dashboard").replace(
            "{TENANT}",
            tenant.slug,
          );

    const stripe = new StripeApi({
      secretKey: opts.stripe.secretKey,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    try {
      const session = await stripe.createBillingPortalSession({
        customerId: cust.stripeCustomerId,
        returnUrl,
      });
      return c.json({ ok: true, url: session.url });
    } catch (err) {
      if (err instanceof StripeApiError) {
        return c.json({ error: "stripe_portal_failed", detail: err.message }, 502);
      }
      throw err;
    }
  });

  /**
   * GET /api/admin/billing/invoices
   * Returns: { invoices: StripeInvoice[] }
   *
   * Последние 12 инвойсов из Stripe. Требует:
   *  - Stripe secretKey (иначе 503)
   *  - Существующий stripeCustomers row (иначе пустой список — tenant ещё
   *    не проходил checkout, это нормально)
   */
  app.get("/api/admin/billing/invoices", async (c) => {
    if (!opts.stripe?.secretKey) {
      return c.json({ error: "stripe_not_configured" }, 503);
    }
    const tenantId = c.var.tenantId;

    const [cust] = await opts.db
      .select({ stripeCustomerId: stripeCustomers.stripeCustomerId })
      .from(stripeCustomers)
      .where(eq(stripeCustomers.tenantId, tenantId));

    if (!cust) {
      // Tenant ещё не проходил checkout — инвойсов нет, не ошибка.
      return c.json({ invoices: [] });
    }

    const stripe = new StripeApi({
      secretKey: opts.stripe.secretKey,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });

    try {
      const result = await stripe.listInvoices({ customerId: cust.stripeCustomerId, limit: 12 });
      const invoices: StripeInvoice[] = result.data.map((inv) => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        amount_due: inv.amount_due,
        amount_paid: inv.amount_paid,
        currency: inv.currency,
        created: inv.created,
        period_start: inv.period_start,
        period_end: inv.period_end,
        hosted_invoice_url: inv.hosted_invoice_url,
        invoice_pdf: inv.invoice_pdf,
        description: inv.description,
      }));
      return c.json({ invoices });
    } catch (err) {
      if (err instanceof StripeApiError) {
        return c.json({ error: "stripe_invoices_failed", detail: err.message }, 502);
      }
      throw err;
    }
  });

  return app;
}
