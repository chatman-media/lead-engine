// Unit/integration test для WhatsApp webhook signature gating.
// БД не нужна — тест focuses на signature middleware: правильная подпись
// проходит дальше pipeline'а, неправильная — 401, отсутствующий header
// → 401.

import { makePlatformMetrics } from "@chatman-media/observability";
import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { ChannelRegistry } from "../channel-registry.ts";
import { makeWhatsAppWebhookRoutes } from "./webhook-whatsapp.ts";

const SECRET = "test-app-secret-abcdef";
const VERIFY_TOKEN = "verify-token";

function sign(payload: string, secret = SECRET): string {
  const hex = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `sha256=${hex}`;
}

function buildApp(appSecret: string | undefined) {
  const metrics = makePlatformMetrics();
  // ChannelRegistry без loadFromDb — getWhatsAppByTenant вернёт пустой
  // массив, handler ответит 404 ДО доступа к БД. Этого достаточно
  // чтобы доказать что signature gating срабатывает раньше.
  const channels = new ChannelRegistry();
  const routes = makeWhatsAppWebhookRoutes({
    // biome-ignore lint/suspicious/noExplicitAny: db не используется в этих тестах
    db: {} as any,
    channels,
    verifyToken: VERIFY_TOKEN,
    ...(appSecret ? { appSecret } : {}),
    metrics,
  });
  return { routes, metrics };
}

describe("webhook-whatsapp signature gating", () => {
  it("valid signature → проходит до tenant-resolve (404 потому что no channels)", async () => {
    const { routes } = buildApp(SECRET);
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const res = await routes.request("/webhook/whatsapp/anywho", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body),
      },
      body,
    });
    // Подпись valid → проходит мимо 401, дальше getWhatsAppByTenant
    // возвращает [] → 404. Без appSecret порядок такой же; но если
    // подпись была бы invalid (см. ниже) — мы бы получили 401, не 404.
    expect(res.status).toBe(404);
  });

  it("invalid signature → 401 (НЕ доходит до tenant resolve)", async () => {
    const { routes, metrics } = buildApp(SECRET);
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const res = await routes.request("/webhook/whatsapp/anywho", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body, "wrong-secret"),
      },
      body,
    });
    expect(res.status).toBe(401);
    const body401 = (await res.json()) as { error: string };
    expect(body401.error).toBe("invalid signature");
    // metric с status="401" должен emit'нуться.
    expect(metrics.registry.format()).toContain(
      'lead_engine_webhook_requests_total{channel="whatsapp",status="401"} 1',
    );
  });

  it("missing X-Hub-Signature-256 header → 401", async () => {
    const { routes } = buildApp(SECRET);
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const res = await routes.request("/webhook/whatsapp/anywho", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("malformed signature (нет sha256= префикса) → 401 (anti-bypass)", async () => {
    const { routes } = buildApp(SECRET);
    const body = "{}";
    // raw hex digest без префикса — мог бы быть наивно accepted в hex-comparison;
    // verifyWhatsAppSignature reject'ит до сравнения.
    const rawHex = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    const res = await routes.request("/webhook/whatsapp/anywho", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": rawHex, // НЕТ "sha256=" префикса
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("appSecret пуст → signature check выключен (dev mode bypass)", async () => {
    const { routes } = buildApp(undefined);
    const body = "{}";
    // Без header'а вообще и без secret — handler пройдёт мимо signature
    // step'а в tenant resolve → 404.
    const res = await routes.request("/webhook/whatsapp/anywho", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(404);
  });

  it("tampered payload даже с valid header → 401 (HMAC от ИЗМЕНЁННЫХ байт)", async () => {
    const { routes } = buildApp(SECRET);
    const original = '{"object":"whatsapp_business_account","entry":[1]}';
    const tampered = '{"object":"whatsapp_business_account","entry":[2]}';
    const res = await routes.request("/webhook/whatsapp/anywho", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(original),
      },
      body: tampered,
    });
    expect(res.status).toBe(401);
  });

  it("GET verify handshake — НЕ затрагивается signature gating", async () => {
    const { routes } = buildApp(SECRET);
    const res = await routes.request(
      `/webhook/whatsapp/anywho?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test-123`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("test-123");
  });
});
