// Unit test для rate-limit gating в webhook handlers. Используем тот же
// pattern что webhook-whatsapp.test.ts — handler с пустым ChannelRegistry
// (404 by default), плюс одна пресuded entry для positive case.

import type { ChannelEntry } from "../channel-registry.ts";
import { makePlatformMetrics } from "@chatman-media/observability";
import { describe, expect, it } from "bun:test";
import { ChannelRegistry } from "../channel-registry.ts";
import { InboundRateLimiter } from "../lib/rate-limiter.ts";
import { makeTelegramWebhookRoutes } from "./webhook-telegram.ts";

class TestChannelRegistry extends ChannelRegistry {
  addEntry(entry: ChannelEntry): void {
    // biome-ignore lint/suspicious/noExplicitAny: tunneling в private
    const byTenant: Map<string, ChannelEntry[]> = (this as any).byTenantSlug;
    // biome-ignore lint/suspicious/noExplicitAny: tunneling в private
    const byDbId: Map<number, ChannelEntry> = (this as any).byDbId;
    const list = byTenant.get(entry.tenantSlug) ?? [];
    list.push(entry);
    byTenant.set(entry.tenantSlug, list);
    byDbId.set(entry.channelDbId, entry);
  }
}

function buildEntry(tenantId: number, slug: string): ChannelEntry {
  // Минимальный fake adapter — pushUpdate + receive нам не нужны для 429-теста.
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter shape
  const fakeAdapter: any = {
    kind: "telegram_bot",
    id: "fake",
    pushUpdate: () => {},
    receive: () =>
      (async function* () {
        // never yields — handler никогда не дойдёт до этого в 429-сценарии.
      })(),
    close: () => {},
  };
  return {
    channelDbId: 1,
    tenantId,
    tenantSlug: slug,
    kind: "telegram_bot",
    externalId: "testbot",
    adapter: fakeAdapter,
  };
}

const WEBHOOK_SECRET = "test-tg-webhook-secret";

describe("webhook rate-limit gating", () => {
  it("если rateLimiter не передан → 429 не возникает", async () => {
    const registry = new TestChannelRegistry();
    registry.addEntry(buildEntry(1, "tenant1"));
    const metrics = makePlatformMetrics();
    const routes = makeTelegramWebhookRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: db не используется
      db: {} as any,
      channels: registry,
      webhookSecret: WEBHOOK_SECRET,
      metrics,
    });
    const res = await routes.request("/webhook/telegram/tenant1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    // Without rate limiter: проходит до pipeline (где fake adapter не yields),
    // handler возвращает 200 ok+processed:false.
    expect(res.status).toBe(200);
  });

  it("rateLimiter с perMinute=1 → второй запрос → 429 с Retry-After", async () => {
    const registry = new TestChannelRegistry();
    registry.addEntry(buildEntry(1, "tenant1"));
    const metrics = makePlatformMetrics();
    const rateLimiter = new InboundRateLimiter({ perMinute: 1, perHour: 100 });
    const routes = makeTelegramWebhookRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: db не используется
      db: {} as any,
      channels: registry,
      webhookSecret: WEBHOOK_SECRET,
      metrics,
      rateLimiter,
    });

    // First call — passes.
    const r1 = await routes.request("/webhook/telegram/tenant1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(r1.status).toBe(200);

    // Second call — over limit.
    const r2 = await routes.request("/webhook/telegram/tenant1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: 2 }),
    });
    expect(r2.status).toBe(429);
    expect(r2.headers.get("Retry-After")).toBeDefined();
    const body = (await r2.json()) as {
      error: string;
      reason: string;
      retryAfterSec: number;
    };
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.reason).toBe("per_minute");
    expect(body.retryAfterSec).toBeGreaterThan(0);

    // Metric counter increments.
    expect(metrics.registry.format()).toContain(
      'lead_engine_webhook_requests_total{channel="telegram_bot",status="429"} 1',
    );
  });

  it("per-tenant: rate-limit для tenant1 не аффектит tenant2", async () => {
    const registry = new TestChannelRegistry();
    registry.addEntry(buildEntry(1, "tenant1"));
    registry.addEntry({ ...buildEntry(2, "tenant2"), channelDbId: 2 });
    const rateLimiter = new InboundRateLimiter({ perMinute: 1, perHour: 100 });
    const metrics = makePlatformMetrics();
    const routes = makeTelegramWebhookRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: db не используется
      db: {} as any,
      channels: registry,
      webhookSecret: WEBHOOK_SECRET,
      metrics,
      rateLimiter,
    });

    await routes.request("/webhook/telegram/tenant1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    // tenant1 над лимитом теперь.
    const tenant1Over = await routes.request("/webhook/telegram/tenant1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: 2 }),
    });
    expect(tenant1Over.status).toBe(429);

    // tenant2 свой counter — ok.
    const tenant2First = await routes.request("/webhook/telegram/tenant2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: 3 }),
    });
    expect(tenant2First.status).toBe(200);
  });
});
