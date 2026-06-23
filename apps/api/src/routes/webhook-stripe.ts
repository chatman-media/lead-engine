import {
  admins,
  stripeCustomers,
  stripeSubscriptions,
  stripeWebhookEvents,
  tenants,
} from "@chatman-media/storage";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { type Mailer, paymentFailedEmailHtml, trialEndingEmailHtml } from "../lib/mailer.ts";
import { StripeSignatureError, verifyStripeSignature } from "../lib/stripe-signature.ts";

/**
 * Минимальный набор Stripe event types которые мы actually обрабатываем.
 * Остальные просто записываются в stripe_webhook_events для audit и
 * возвращается 200 (Stripe не ретриит на 200).
 */
const HANDLED_EVENTS = new Set([
  "customer.created",
  "customer.updated",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
]);

interface StripeEventBase {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

interface StripeCustomer {
  id: string;
  email?: string;
  metadata?: Record<string, string>;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  items: { data: Array<{ price: { id: string } }> };
  current_period_start?: number;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
}

/**
 * Hono routes для Stripe webhook'а. Один endpoint POST /webhook/stripe —
 * Stripe всех tenants шлёт сюда (один endpoint per Stripe account, а
 * tenant_id определяется через customer→stripeCustomers JOIN).
 */
export function makeStripeWebhookRoutes(opts: {
  db: PostgresJsDatabase<Record<string, never>>;
  webhookSecret: string;
  /**
   * Map Stripe priceId → plan kind. Webhook handler по получении
   * `customer.subscription.created/updated` resolves плану и mutates
   * `tenants.plan`. На `customer.subscription.deleted` → downgrade to 'free'.
   * Если pricing unknown — plan не меняется (warning в log'е).
   */
  priceToPlan?: Record<string, "starter" | "pro">;
  /** Опциональный mailer для email-нотификаций (trial_will_end, payment_failed). */
  mailer?: Mailer;
  /** Base URL admin-UI (для ссылок в письмах). */
  appUrl?: string;
}): Hono {
  const priceMap = opts.priceToPlan ?? {};
  const app = new Hono();

  app.post("/webhook/stripe", async (c) => {
    const sig = c.req.header("Stripe-Signature");
    const raw = await c.req.text();
    try {
      verifyStripeSignature({
        secret: opts.webhookSecret,
        payload: raw,
        header: sig,
      });
    } catch (err) {
      if (err instanceof StripeSignatureError) {
        return c.json({ error: "invalid signature", reason: err.reason }, 400);
      }
      throw err;
    }

    let event: StripeEventBase;
    try {
      event = JSON.parse(raw) as StripeEventBase;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    // Idempotency check — если event.id уже processed, 200 без работы.
    // biome-ignore lint/suspicious/noExplicitAny: PostgresJsDatabase generic
    const existing = await (opts.db as any)
      .select({ id: stripeWebhookEvents.stripeEventId })
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.stripeEventId, event.id));
    if (existing.length > 0) {
      return c.json({ ok: true, deduped: true });
    }

    let tenantId: number | null = null;
    try {
      tenantId = await applyEvent(
        opts.db,
        event,
        priceMap,
        opts.mailer,
        opts.appUrl ?? "https://app.leadengine.app",
      );
    } catch (err) {
      console.warn(`[stripe webhook] event ${event.id} (${event.type}) failed:`, err);
      // Не записываем в processed — Stripe ретриит, и при retry'е попытаемся
      // снова. Возвращаем 500 чтобы Stripe знал.
      return c.json({ error: "event processing failed" }, 500);
    }

    // Записываем processed only после успешного apply.
    // biome-ignore lint/suspicious/noExplicitAny: PostgresJsDatabase generic
    await (opts.db as any)
      .insert(stripeWebhookEvents)
      .values({
        stripeEventId: event.id,
        type: event.type,
        ...(tenantId !== null ? { tenantId } : {}),
        rawPayload: raw,
      })
      .onConflictDoNothing();

    return c.json({ ok: true, type: event.type, handled: HANDLED_EVENTS.has(event.type) });
  });

  return app;
}

/**
 * Применяет event к БД. Возвращает tenant_id если резолвится из
 * customer→stripeCustomers JOIN, иначе null (это customer.created без
 * существующего mapping'а — оператор должен onboard'нуть руками).
 */
async function applyEvent(
  // biome-ignore lint/suspicious/noExplicitAny: PostgresJsDatabase generic
  db: any,
  event: StripeEventBase,
  priceMap: Record<string, "starter" | "pro">,
  mailer?: Mailer,
  appUrl?: string,
): Promise<number | null> {
  if (!HANDLED_EVENTS.has(event.type)) return null;

  if (event.type === "customer.created" || event.type === "customer.updated") {
    const customer = event.data.object as unknown as StripeCustomer;
    return applyCustomer(db, customer);
  }

  if (event.type.startsWith("customer.subscription.")) {
    const sub = event.data.object as unknown as StripeSubscription;
    const tenantId = await applySubscription(
      db,
      sub,
      event.type === "customer.subscription.deleted",
      priceMap,
    );

    // Email: trial закончится через 3 дня (Stripe шлёт за 3 дня до trial_end).
    if (event.type === "customer.subscription.trial_will_end" && mailer && tenantId) {
      const trialEnd = (sub as unknown as { trial_end?: number }).trial_end;
      const daysLeft = trialEnd
        ? Math.max(1, Math.round((trialEnd * 1000 - Date.now()) / 86400000))
        : 3;
      const info = await getTenantEmailInfo(db, tenantId);
      if (info) {
        await mailer
          .send({
            to: info.email,
            subject: `Ваш триал lead-engine заканчивается через ${daysLeft} ${daysLeft === 1 ? "день" : "дня"}`,
            html: trialEndingEmailHtml({
              email: info.email,
              slug: info.slug,
              daysLeft,
              appUrl: appUrl ?? "https://app.leadengine.app",
              billingUrl: `${appUrl ?? "https://app.leadengine.app"}/billing`,
            }),
          })
          .catch((e) => console.warn("[mailer] trial_will_end send failed:", e));
      }
    }

    return tenantId;
  }

  // invoice.payment_failed — отправляем email.
  if (event.type === "invoice.payment_failed" && mailer) {
    const invoice = event.data.object as { customer?: string };
    const stripeCustomerId = typeof invoice.customer === "string" ? invoice.customer : null;
    if (stripeCustomerId) {
      const [cust] = await db
        .select({ tenantId: stripeCustomers.tenantId })
        .from(stripeCustomers)
        .where(eq(stripeCustomers.stripeCustomerId, stripeCustomerId));
      if (cust?.tenantId) {
        const info = await getTenantEmailInfo(db, cust.tenantId);
        if (info) {
          await mailer
            .send({
              to: info.email,
              subject: "Не удалось списать оплату lead-engine",
              html: paymentFailedEmailHtml({
                email: info.email,
                slug: info.slug,
                appUrl: appUrl ?? "https://app.leadengine.app",
                billingUrl: `${appUrl ?? "https://app.leadengine.app"}/billing`,
              }),
            })
            .catch((e) => console.warn("[mailer] payment_failed send failed:", e));
          return cust.tenantId;
        }
      }
    }
  }

  // invoice.payment_succeeded — no-op (только audit-log).
  return null;
}

/** Возвращает email + slug владельца (superadmin) тенанта. */
async function getTenantEmailInfo(
  // biome-ignore lint/suspicious/noExplicitAny: PostgresJsDatabase generic
  db: any,
  tenantId: number,
): Promise<{ email: string; slug: string } | null> {
  const [row] = await db
    .select({ email: admins.email, slug: tenants.slug })
    .from(admins)
    .innerJoin(tenants, eq(tenants.id, admins.tenantId))
    .where(eq(admins.tenantId, tenantId))
    .orderBy(admins.id) // первый зарегистрированный = owner
    .limit(1);
  return row ?? null;
}

async function applyCustomer(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle generic
  db: any,
  customer: StripeCustomer,
): Promise<number | null> {
  // Сматчить customer на tenant: пытаемся через metadata.tenant_slug или
  // tenant_id, потом через email lookup в tenants (опционально).
  const metaTenantSlug = customer.metadata?.tenant_slug;
  const metaTenantId = customer.metadata?.tenant_id
    ? Number.parseInt(customer.metadata.tenant_id, 10)
    : null;
  let tenantId: number | null = null;
  if (metaTenantSlug) {
    const [t] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, metaTenantSlug));
    if (t) tenantId = t.id;
  }
  if (!tenantId && metaTenantId !== null && Number.isFinite(metaTenantId)) {
    const [t] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, metaTenantId));
    if (t) tenantId = t.id;
  }
  if (!tenantId) {
    console.warn(
      `[stripe] customer ${customer.id} not mapped to tenant (no metadata.tenant_slug/id)`,
    );
    return null;
  }
  await db
    .insert(stripeCustomers)
    .values({
      tenantId,
      stripeCustomerId: customer.id,
      ...(customer.email ? { email: customer.email } : {}),
    })
    .onConflictDoUpdate({
      target: stripeCustomers.stripeCustomerId,
      set: {
        ...(customer.email ? { email: customer.email } : {}),
        updatedAt: sql`EXTRACT(EPOCH FROM NOW())::INTEGER`,
      },
    });
  return tenantId;
}

async function applySubscription(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle generic
  db: any,
  sub: StripeSubscription,
  isDeleted: boolean,
  priceMap: Record<string, "starter" | "pro">,
): Promise<number | null> {
  const [customer] = await db
    .select({ tenantId: stripeCustomers.tenantId })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.stripeCustomerId, sub.customer));
  if (!customer) {
    console.warn(`[stripe] subscription ${sub.id} for unknown customer ${sub.customer}`);
    return null;
  }
  const priceId = sub.items.data[0]?.price.id;
  if (!priceId) {
    console.warn(`[stripe] subscription ${sub.id} has no items`);
    return customer.tenantId;
  }
  const status = isDeleted ? "canceled" : sub.status;
  await db
    .insert(stripeSubscriptions)
    .values({
      tenantId: customer.tenantId,
      stripeCustomerId: sub.customer,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      status,
      ...(sub.current_period_start ? { currentPeriodStart: sub.current_period_start } : {}),
      ...(sub.current_period_end ? { currentPeriodEnd: sub.current_period_end } : {}),
      ...(sub.cancel_at_period_end !== undefined
        ? { cancelAtPeriodEnd: sub.cancel_at_period_end }
        : {}),
      ...(sub.metadata ? { metadataJson: JSON.stringify(sub.metadata) } : {}),
    })
    .onConflictDoUpdate({
      target: stripeSubscriptions.stripeSubscriptionId,
      set: {
        status,
        stripePriceId: priceId,
        ...(sub.current_period_start ? { currentPeriodStart: sub.current_period_start } : {}),
        ...(sub.current_period_end ? { currentPeriodEnd: sub.current_period_end } : {}),
        ...(sub.cancel_at_period_end !== undefined
          ? { cancelAtPeriodEnd: sub.cancel_at_period_end }
          : {}),
        updatedAt: sql`EXTRACT(EPOCH FROM NOW())::INTEGER`,
      },
    });

  // Sync tenants.plan + tenants.status based on subscription status.
  //
  // Plan:
  //   - isDeleted → 'free' (canceled, no entitlement).
  //   - status='active' | 'trialing' → map priceId → plan.
  //   - status='past_due' | 'unpaid' → keep current plan (Stripe retries).
  //   - unknown priceId → no plan change.
  //
  // Status (auto-suspend):
  //   - 'unpaid' → suspended (Stripe exhausted all retry attempts).
  //   - 'active' | 'trialing' → active (восстанавливаем если был suspended).
  //   - 'past_due' | 'canceled' | deleted → не меняем (grace / intentional).
  let newPlan: "free" | "starter" | "pro" | null = null;
  if (isDeleted) {
    newPlan = "free";
  } else if (status === "active" || status === "trialing") {
    const mapped = priceMap[priceId];
    if (mapped) newPlan = mapped;
    else console.warn(`[stripe] unknown priceId ${priceId} — tenant.plan не меняется`);
  }

  let newTenantStatus: "active" | "suspended" | null = null;
  if (status === "unpaid") {
    newTenantStatus = "suspended";
    console.warn(`[stripe] tenant ${customer.tenantId} suspended — subscription unpaid`);
  } else if (status === "active" || status === "trialing") {
    // Восстанавливаем если был suspended по billing-причине.
    newTenantStatus = "active";
  }

  if (newPlan || newTenantStatus) {
    await db
      .update(tenants)
      .set({
        ...(newPlan ? { plan: newPlan } : {}),
        ...(newTenantStatus ? { status: newTenantStatus } : {}),
        updatedAt: sql`EXTRACT(EPOCH FROM NOW())::INTEGER`,
      })
      .where(eq(tenants.id, customer.tenantId));
  }

  return customer.tenantId;
}
