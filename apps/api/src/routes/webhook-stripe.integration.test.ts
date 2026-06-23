// Integration test for the Stripe webhook. Signatures are crafted with the same
// HMAC scheme verifyStripeSignature uses (no Stripe SDK). Covers signature
// guards, idempotency, customer mapping, subscription→plan sync.
// Coverage epic #187 — apps/api untested routes.

import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeAuthRoutes } from "./auth.ts";
import { makeStripeWebhookRoutes } from "./webhook-stripe.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_stripe_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "storage",
  "migrations",
);
const SECRET = "test-secret-stripe-flow-12345";
const WHSEC = "whsec_test_12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let appMailer: Hono; // вариант с фейковым mailer для email-веток
const sentEmails: Array<{ to: string; subject: string }> = [];
let tenantId = 0;

function sign(raw: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WHSEC).update(`${t}.${raw}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

async function send(
  event: unknown,
  opts: { sig?: "valid" | "bad" | "none"; rawOverride?: string; app?: Hono } = {},
): Promise<Response> {
  const raw = opts.rawOverride ?? JSON.stringify(event);
  const sigMode = opts.sig ?? "valid";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sigMode === "valid") headers["Stripe-Signature"] = sign(raw);
  else if (sigMode === "bad")
    headers["Stripe-Signature"] = `t=${Math.floor(Date.now() / 1000)},v1=00`;
  return (opts.app ?? app).request("/webhook/stripe", { method: "POST", headers, body: raw });
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route(
    "/",
    makeStripeWebhookRoutes({
      db: db as any,
      webhookSecret: WHSEC,
      priceToPlan: { price_pro: "pro" },
    }),
  );

  appMailer = new Hono();
  appMailer.route(
    "/",
    makeStripeWebhookRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
      db: db as any,
      webhookSecret: WHSEC,
      priceToPlan: { price_pro: "pro" },
      // biome-ignore lint/suspicious/noExplicitAny: minimal mailer fake
      mailer: {
        send: async (m: { to: string; subject: string }) => {
          sentEmails.push(m);
        },
      } as any,
      appUrl: "https://app.test",
    }),
  );

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "stripe@demo.io", password: "strong-pwd-12345" }),
  });
  tenantId = ((await sa.json()) as { admin: { tenantId: number } }).admin.tenantId;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function plan(): Promise<string> {
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId));
  return t!.plan;
}

describe("webhook-stripe", () => {
  it("нет подписи → 400; кривая подпись → 400", async () => {
    if (!sql) return;
    expect(
      (await send({ id: "evt_x", type: "ping", created: 0, data: { object: {} } }, { sig: "none" }))
        .status,
    ).toBe(400);
    expect(
      (await send({ id: "evt_x", type: "ping", created: 0, data: { object: {} } }, { sig: "bad" }))
        .status,
    ).toBe(400);
  });

  it("валидная подпись + битый JSON → 400", async () => {
    if (!sql) return;
    expect((await send(null, { rawOverride: "{not json" })).status).toBe(400);
  });

  it("необрабатываемый тип → 200 handled:false", async () => {
    if (!sql) return;
    const res = await send({ id: "evt_ping", type: "ping", created: 0, data: { object: {} } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { handled: boolean }).handled).toBe(false);
  });

  it("customer.created (metadata.tenant_id) → маппинг; subscription.created (price_pro) → plan=pro", async () => {
    if (!sql) return;
    const cust = await send({
      id: "evt_cust",
      type: "customer.created",
      created: 0,
      data: { object: { id: "cus_1", email: "c@x.io", metadata: { tenant_id: String(tenantId) } } },
    });
    expect(cust.status).toBe(200);

    const subEvent = {
      id: "evt_sub",
      type: "customer.subscription.created",
      created: 0,
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          items: { data: [{ price: { id: "price_pro" } }] },
        },
      },
    };
    expect((await send(subEvent)).status).toBe(200);
    expect(await plan()).toBe("pro");

    // Идемпотентность: повтор того же event.id → deduped.
    expect(((await (await send(subEvent)).json()) as { deduped?: boolean }).deduped).toBe(true);
  });

  it("subscription.deleted → plan=free", async () => {
    if (!sql) return;
    const res = await send({
      id: "evt_sub_del",
      type: "customer.subscription.deleted",
      created: 0,
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "canceled",
          items: { data: [{ price: { id: "price_pro" } }] },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(await plan()).toBe("free");
  });

  it("customer без mapping / неизвестный customer / без items → 200 (no-op ветки)", async () => {
    if (!sql) return;
    expect(
      (
        await send({
          id: "evt_c2",
          type: "customer.created",
          created: 0,
          data: { object: { id: "cus_2", metadata: {} } },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send({
          id: "evt_unk",
          type: "customer.subscription.created",
          created: 0,
          data: {
            object: {
              id: "sub_unk",
              customer: "cus_unknown",
              status: "active",
              items: { data: [{ price: { id: "price_pro" } }] },
            },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send({
          id: "evt_noitems",
          type: "customer.subscription.updated",
          created: 0,
          data: {
            object: { id: "sub_ni", customer: "cus_1", status: "active", items: { data: [] } },
          },
        })
      ).status,
    ).toBe(200);
  });

  it("subscription unpaid → tenant suspended", async () => {
    if (!sql) return;
    await send({
      id: "evt_unpaid",
      type: "customer.subscription.updated",
      created: 0,
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "unpaid",
          items: { data: [{ price: { id: "price_pro" } }] },
        },
      },
    });
    const [t] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    expect(t!.status).toBe("suspended");
  });

  it("mailer: trial_will_end + payment_failed → письма владельцу", async () => {
    if (!sql) return;
    sentEmails.length = 0;
    await send(
      {
        id: "evt_trial",
        type: "customer.subscription.trial_will_end",
        created: 0,
        data: {
          object: {
            id: "sub_1",
            customer: "cus_1",
            status: "trialing",
            trial_end: Math.floor(Date.now() / 1000) + 3 * 86400,
            items: { data: [{ price: { id: "price_pro" } }] },
          },
        },
      },
      { app: appMailer },
    );
    await send(
      {
        id: "evt_pf",
        type: "invoice.payment_failed",
        created: 0,
        data: { object: { customer: "cus_1" } },
      },
      { app: appMailer },
    );
    expect(sentEmails.length).toBe(2);
  });
});
