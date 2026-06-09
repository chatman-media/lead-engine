// Unit-тест для Facebook Messenger webhook signature gating. Зеркалит
// webhook-whatsapp.test.ts: per-tenant app_secret валидируется ПОСЛЕ резолва
// тенанта по slug (нужен per-tenant secret из ChannelEntry), поэтому unknown
// slug → 404 раньше 401. Payload с entry:[] не порождает inbound'ов —
// pipeline/БД не нужны.

import { MessengerAdapter } from "@chatman-media/channel-facebook";
import { makePlatformMetrics } from "@chatman-media/observability";
import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { type ChannelEntry, ChannelRegistry } from "../channel-registry.ts";
import { makeFacebookWebhookRoutes } from "./webhook-facebook.ts";

const SECRET = "test-app-secret-abcdef";
const ENV_SECRET = "env-app-secret-zzz";
const VERIFY_TOKEN = "verify-token";
const SLUG = "anywho";
const EMPTY_PAYLOAD = '{"object":"page","entry":[]}';

function sign(payload: string, secret = SECRET): string {
  const hex = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `sha256=${hex}`;
}

/** Сидит активный Facebook-канал для slug, минуя loadFromDb (БД не нужна). */
function seedFacebook(channels: ChannelRegistry, extra: Partial<ChannelEntry> = {}): void {
  const adapter = new MessengerAdapter({ id: "1", pageAccessToken: "stub" });
  const entry: ChannelEntry = {
    channelDbId: 1,
    tenantId: 1,
    tenantSlug: SLUG,
    tenantPlan: "free",
    kind: "facebook",
    externalId: "123456789012",
    adapter,
    ...extra,
  };
  // biome-ignore lint/suspicious/noExplicitAny: тест-сем для приватной мапы
  (channels as any).byTenantSlug.set(SLUG, [entry]);
}

function buildApp(
  opts: { appSecret?: string; seed?: Partial<ChannelEntry> | false; verifyToken?: string } = {},
) {
  const metrics = makePlatformMetrics();
  const channels = new ChannelRegistry();
  if (opts.seed !== false) seedFacebook(channels, opts.seed ?? {});
  const routes = makeFacebookWebhookRoutes({
    // biome-ignore lint/suspicious/noExplicitAny: db не используется в этих тестах
    db: {} as any,
    channels,
    verifyToken: opts.verifyToken ?? VERIFY_TOKEN,
    ...(opts.appSecret ? { appSecret: opts.appSecret } : {}),
    metrics,
  });
  return { routes, metrics };
}

describe("webhook-facebook signature gating", () => {
  it("valid signature (per-tenant app_secret) → проходит gate (200, processed 0)", async () => {
    const { routes } = buildApp({ seed: { facebookAppSecret: SECRET } });
    const res = await routes.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(EMPTY_PAYLOAD),
      },
      body: EMPTY_PAYLOAD,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; processed: number };
    expect(json.ok).toBe(true);
    expect(json.processed).toBe(0);
  });

  it("unknown slug → 404 (lookup идёт раньше signature)", async () => {
    const { routes } = buildApp({ appSecret: ENV_SECRET, seed: false });
    const res = await routes.request("/webhook/facebook/nope", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(EMPTY_PAYLOAD, ENV_SECRET),
      },
      body: EMPTY_PAYLOAD,
    });
    expect(res.status).toBe(404);
  });

  it("invalid signature → 401", async () => {
    const { routes, metrics } = buildApp({ seed: { facebookAppSecret: SECRET } });
    const res = await routes.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(EMPTY_PAYLOAD, "wrong-secret"),
      },
      body: EMPTY_PAYLOAD,
    });
    expect(res.status).toBe(401);
    const body401 = (await res.json()) as { error: string };
    expect(body401.error).toBe("invalid signature");
    expect(metrics.registry.format()).toContain(
      'lead_engine_webhook_requests_total{channel="facebook",status="401"} 1',
    );
  });

  it("missing X-Hub-Signature-256 header → 401", async () => {
    const { routes } = buildApp({ seed: { facebookAppSecret: SECRET } });
    const res = await routes.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: EMPTY_PAYLOAD,
    });
    expect(res.status).toBe(401);
  });

  it("malformed signature (нет sha256= префикса) → 401 (anti-bypass)", async () => {
    const { routes } = buildApp({ seed: { facebookAppSecret: SECRET } });
    const body = "{}";
    const rawHex = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    const res = await routes.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": rawHex, // НЕТ "sha256=" префикса
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("appSecret пуст (ни entry, ни env) → signature check выключен (dev bypass) → 200", async () => {
    const { routes } = buildApp(); // entry без secret, opts без appSecret
    const res = await routes.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: EMPTY_PAYLOAD,
    });
    expect(res.status).toBe(200);
  });

  it("tampered payload даже с valid header → 401 (HMAC от ИЗМЕНЁННЫХ байт)", async () => {
    const { routes } = buildApp({ seed: { facebookAppSecret: SECRET } });
    const original = '{"object":"page","entry":[1]}';
    const tampered = '{"object":"page","entry":[2]}';
    const res = await routes.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(original),
      },
      body: tampered,
    });
    expect(res.status).toBe(401);
  });

  it("per-tenant app_secret имеет приоритет над env-фолбэком", async () => {
    const ok = await buildApp({
      appSecret: ENV_SECRET,
      seed: { facebookAppSecret: SECRET },
    }).routes.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(EMPTY_PAYLOAD) },
      body: EMPTY_PAYLOAD,
    });
    expect(ok.status).toBe(200);

    const rejected = await buildApp({
      appSecret: ENV_SECRET,
      seed: { facebookAppSecret: SECRET },
    }).routes.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(EMPTY_PAYLOAD, ENV_SECRET),
      },
      body: EMPTY_PAYLOAD,
    });
    expect(rejected.status).toBe(401);
  });

  it("env app_secret используется как фолбэк, если у тенанта свой не задан", async () => {
    const { routes } = buildApp({ appSecret: ENV_SECRET }); // entry без своего secret
    const res = await routes.request(`/webhook/facebook/${SLUG}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(EMPTY_PAYLOAD, ENV_SECRET),
      },
      body: EMPTY_PAYLOAD,
    });
    expect(res.status).toBe(200);
  });

  it("GET verify handshake — per-tenant verify_token", async () => {
    const { routes } = buildApp({ seed: { facebookVerifyToken: "tenant-vt" } });
    const res = await routes.request(
      `/webhook/facebook/${SLUG}?hub.mode=subscribe&hub.verify_token=tenant-vt&hub.challenge=test-123`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("test-123");
  });

  it("GET verify handshake — работает без глобального verify_token, если токен задан в канале", async () => {
    const { routes } = buildApp({ seed: { facebookVerifyToken: "tenant-vt" }, verifyToken: "" });
    const res = await routes.request(
      `/webhook/facebook/${SLUG}?hub.mode=subscribe&hub.verify_token=tenant-vt&hub.challenge=test-123`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("test-123");
  });

  it("GET verify handshake — фолбэк на глобальный verify_token", async () => {
    const { routes } = buildApp({ seed: false });
    const res = await routes.request(
      `/webhook/facebook/${SLUG}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test-123`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("test-123");
  });
});
