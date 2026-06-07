// Integration test for the WhatsApp Cloud webhook — real processInbound pipeline
// on an isolated DB. Complements webhook-whatsapp.test.ts (signature-only).
// Covers: GET verify subscription, POST invalid-json, POST rate-limit, POST
// happy-path (message persisted in DB), POST 404 unknown slug.

import { WhatsAppCloudAdapter } from "@chatman-media/channel-whatsapp";
import { withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  messages,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { type ChannelEntry, ChannelRegistry } from "../channel-registry.ts";
import { makeAuthRoutes } from "./auth.ts";
import { makeWhatsAppWebhookRoutes } from "./webhook-whatsapp.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_wawh_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-wawh-12345";
const APP_SECRET = "wa-app-secret-abcdef";
const VERIFY_TOKEN = "wa-verify-token-xyz";
const SLUG = "wa-test-tenant";
const PHONE_ID = "123456789012";
const FROM_NUMBER = "79161234567";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tenantId = 0;
let channelDbId = 0;
let entry: ChannelEntry | null = null;

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(payload, "utf8").digest("hex")}`;
}

function waPayload(text: string, fromId = FROM_NUMBER): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "biz",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          messages: [{
            from: fromId,
            id: `wa.${Math.random().toString(36).slice(2, 10)}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: "text",
            text: { body: text },
          }],
          contacts: [{ profile: { name: "Иван Тест" }, wa_id: fromId }],
        },
      }],
    }],
  });
}

async function post(body: string, withSig = true, instance?: Hono): Promise<Response> {
  return (instance ?? app).request(`/webhook/whatsapp/${SLUG}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withSig ? { "X-Hub-Signature-256": sign(body) } : {}),
    },
    body,
  });
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

  // Build registry before adding routes (Hono router freezes after first request)
  const registry = new ChannelRegistry();

  app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  app.route("/", makeWhatsAppWebhookRoutes({
    db,
    channels: registry,
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
  }));

  const signup = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "wawh@demo.io", password: "strong-pwd-12345" }),
  });
  const signupBody = (await signup.json()) as { tenant: { id: number } };
  tenantId = signupBody.tenant.id;

  // Create a WhatsApp channel in DB
  const [ch] = await db.insert(channels).values({
    tenantId,
    kind: "whatsapp",
    externalId: PHONE_ID,
    status: "active",
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
  }).returning({ id: channels.id });
  channelDbId = ch!.id;

  const adapter = new WhatsAppCloudAdapter({
    id: String(channelDbId),
    phoneNumberId: PHONE_ID,
    accessToken: "stub-access-token",
  });

  // Populate registry after signup so tenantId is known
  entry = {
    channelDbId,
    tenantId,
    tenantSlug: SLUG,
    tenantPlan: "free",
    kind: "whatsapp",
    externalId: PHONE_ID,
    adapter,
    whatsappAppSecret: APP_SECRET,
  } as ChannelEntry;
  // biome-ignore lint/suspicious/noExplicitAny: inject into private registry map
  (registry as any).byTenantSlug.set(SLUG, [entry]);
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("webhook-whatsapp GET verify subscription", () => {
  it("корректный handshake → 200 + challenge", async () => {
    if (!sql) return;
    const res = await app.request(
      `/webhook/whatsapp/${SLUG}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc123`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });

  it("неверный verify_token → 403", async () => {
    if (!sql) return;
    const res = await app.request(
      `/webhook/whatsapp/${SLUG}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc`,
    );
    expect(res.status).toBe(403);
  });
});

describe("webhook-whatsapp POST — guards", () => {
  it("неизвестный slug → 404", async () => {
    if (!sql) return;
    const body = waPayload("hi");
    const res = await app.request("/webhook/whatsapp/unknown-slug", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body) },
      body,
    });
    expect(res.status).toBe(404);
  });

  it("неверная подпись → 401", async () => {
    if (!sql) return;
    const body = waPayload("hello");
    const res = await app.request(`/webhook/whatsapp/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=bad" },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("невалидный JSON → 400", async () => {
    if (!sql) return;
    const raw = "{ not valid json";
    const res = await app.request(`/webhook/whatsapp/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(raw) },
      body: raw,
    });
    expect(res.status).toBe(400);
  });
});

describe("webhook-whatsapp POST — rate-limit", () => {
  it("rate-limiter запрещает → 429", async () => {
    if (!sql) return;
    const registry = new ChannelRegistry();
    const adapter = new WhatsAppCloudAdapter({
      id: String(channelDbId),
      phoneNumberId: PHONE_ID,
      accessToken: "stub",
    });
    // biome-ignore lint/suspicious/noExplicitAny: inject
    (registry as any).byTenantSlug.set(SLUG, [{
      channelDbId,
      tenantId,
      tenantSlug: SLUG,
      tenantPlan: "free",
      kind: "whatsapp",
      externalId: PHONE_ID,
      adapter,
      whatsappAppSecret: APP_SECRET,
    }]);

    const appRl = new Hono();
    appRl.route("/", makeWhatsAppWebhookRoutes({
      db,
      channels: registry,
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      rateLimiter: { check: () => ({ allowed: false, reason: "per_minute", retryAfterSec: 60 }) } as never,
    }));

    const body = waPayload("test rate limit");
    const res = await appRl.request(`/webhook/whatsapp/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body) },
      body,
    });
    expect(res.status).toBe(429);
  });
});

describe("webhook-whatsapp POST — happy path", () => {
  it("текстовое сообщение → 200, сообщение сохранено в БД", async () => {
    if (!sql) return;
    const text = `WA integration test ${Date.now()}`;
    const body = waPayload(text);
    const res = await post(body);
    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as { ok: boolean; processed: number };
    expect(responseBody.ok).toBe(true);
    expect(responseBody.processed).toBe(1);

    // Verify message persisted
    const saved = await withTenant(db, tenantId, async (tx) =>
      tx.select({ text: messages.text })
        .from(messages)
        .where(eq(messages.tenantId, tenantId))
        .limit(10),
    );
    expect(saved.some((m) => m.text === text)).toBe(true);
  });

  it("пустой entry → 200, processed=0", async () => {
    if (!sql) return;
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const res = await post(body);
    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as { processed: number };
    expect(responseBody.processed).toBe(0);
  });
});
