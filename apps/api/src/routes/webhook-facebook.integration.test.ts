// Integration test for the Facebook Messenger webhook — real processInbound
// pipeline on an isolated DB. Complements webhook-facebook.test.ts (sig-only).
// Covers: GET verify subscription, POST invalid-json, POST rate-limit, POST
// happy-path (message persisted in DB), POST 404 unknown slug.

import { MessengerAdapter } from "@chatman-media/channel-facebook";
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
import { makeFacebookWebhookRoutes } from "./webhook-facebook.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_fbwh_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-fbwh-12345";
const APP_SECRET = "fb-app-secret-abcdef";
const VERIFY_TOKEN = "fb-verify-token-xyz";
const SLUG = "fb-test-tenant";
const PAGE_ID = "987654321012";
const SENDER_PSID = "2001001001001001";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tenantId = 0;
let channelDbId = 0;

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(payload, "utf8").digest("hex")}`;
}

function fbPayload(text: string, senderId = SENDER_PSID): string {
  return JSON.stringify({
    object: "page",
    entry: [
      {
        id: PAGE_ID,
        time: Math.floor(Date.now() / 1000),
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: PAGE_ID },
            timestamp: Math.floor(Date.now() / 1000) * 1000,
            message: {
              mid: `m_${Math.random().toString(36).slice(2, 10)}`,
              text,
            },
          },
        ],
      },
    ],
  });
}

async function post(body: string, withSig = true, instance?: Hono): Promise<Response> {
  return (instance ?? app).request(`/webhook/facebook/${SLUG}`, {
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
  app.route(
    "/",
    makeFacebookWebhookRoutes({
      db,
      channels: registry,
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
    }),
  );

  const signup = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "fbwh@demo.io", password: "strong-pwd-12345" }),
  });
  const signupBody = (await signup.json()) as { tenant: { id: number } };
  tenantId = signupBody.tenant.id;

  // Create a Facebook channel in DB
  const [ch] = await db
    .insert(channels)
    .values({
      tenantId,
      kind: "facebook",
      externalId: PAGE_ID,
      status: "active",
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .returning({ id: channels.id });
  channelDbId = ch!.id;

  const adapter = new MessengerAdapter({
    id: String(channelDbId),
    pageAccessToken: "stub-page-access-token",
  });

  // Populate registry after signup so tenantId is known
  const entry: ChannelEntry = {
    channelDbId,
    tenantId,
    tenantSlug: SLUG,
    tenantPlan: "free",
    kind: "facebook",
    externalId: PAGE_ID,
    adapter,
    facebookAppSecret: APP_SECRET,
  } as ChannelEntry;
  // biome-ignore lint/suspicious/noExplicitAny: inject into private registry map
  (registry as any).byTenantSlug.set(SLUG, [entry]);
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("webhook-facebook GET verify subscription", () => {
  it("корректный handshake → 200 + challenge", async () => {
    if (!sql) return;
    const res = await app.request(
      `/webhook/facebook/${SLUG}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=fbchallenge123`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fbchallenge123");
  });

  it("неверный verify_token → 403", async () => {
    if (!sql) return;
    const res = await app.request(
      `/webhook/facebook/${SLUG}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`,
    );
    expect(res.status).toBe(403);
  });
});

describe("webhook-facebook POST — guards", () => {
  it("неизвестный slug → 404", async () => {
    if (!sql) return;
    const body = fbPayload("hi");
    const res = await app.request("/webhook/facebook/unknown-slug", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body) },
      body,
    });
    expect(res.status).toBe(404);
  });

  it("неверная подпись → 401", async () => {
    if (!sql) return;
    const body = fbPayload("hello");
    const res = await app.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=bad" },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("невалидный JSON → 400", async () => {
    if (!sql) return;
    const raw = "{ not valid json";
    const res = await app.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(raw) },
      body: raw,
    });
    expect(res.status).toBe(400);
  });
});

describe("webhook-facebook POST — rate-limit", () => {
  it("rate-limiter запрещает → 429", async () => {
    if (!sql) return;
    const registry = new ChannelRegistry();
    const adapter = new MessengerAdapter({ id: String(channelDbId), pageAccessToken: "stub" });
    // biome-ignore lint/suspicious/noExplicitAny: inject
    (registry as any).byTenantSlug.set(SLUG, [
      {
        channelDbId,
        tenantId,
        tenantSlug: SLUG,
        tenantPlan: "free",
        kind: "facebook",
        externalId: PAGE_ID,
        adapter,
        facebookAppSecret: APP_SECRET,
      },
    ]);

    const appRl = new Hono();
    appRl.route(
      "/",
      makeFacebookWebhookRoutes({
        db,
        channels: registry,
        verifyToken: VERIFY_TOKEN,
        appSecret: APP_SECRET,
        rateLimiter: {
          check: () => ({ allowed: false, reason: "per_minute", retryAfterSec: 60 }),
        } as never,
      }),
    );

    const body = fbPayload("rate limit test");
    const res = await appRl.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body) },
      body,
    });
    expect(res.status).toBe(429);
  });
});

describe("webhook-facebook POST — happy path", () => {
  it("текстовое сообщение → 200, сообщение сохранено в БД", async () => {
    if (!sql) return;
    const text = `FB integration test ${Date.now()}`;
    const body = fbPayload(text);
    const res = await post(body);
    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as { ok: boolean; processed: number };
    expect(responseBody.ok).toBe(true);
    expect(responseBody.processed).toBe(1);

    // Verify message persisted
    const saved = await withTenant(db, tenantId, async (tx) =>
      tx
        .select({ text: messages.text })
        .from(messages)
        .where(eq(messages.tenantId, tenantId))
        .limit(10),
    );
    expect(saved.some((m) => m.text === text)).toBe(true);
  });

  it("пустой entry → 200, processed=0", async () => {
    if (!sql) return;
    const body = JSON.stringify({ object: "page", entry: [] });
    const res = await post(body);
    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as { processed: number };
    expect(responseBody.processed).toBe(0);
  });
});
