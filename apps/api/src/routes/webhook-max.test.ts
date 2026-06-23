import { MaxAdapter } from "@chatman-media/channel-max";
import { makePlatformMetrics } from "@chatman-media/observability";
import { describe, expect, it } from "bun:test";
import { type ChannelEntry, ChannelRegistry } from "../channel-registry.ts";
import { makeMaxWebhookRoutes } from "./webhook-max.ts";

const SLUG = "max-tenant";
const BOT_ID = "778899";
const SECRET = "max-secret";

function makeMaxEntry(extra: Partial<ChannelEntry> = {}): ChannelEntry {
  const adapter = new MaxAdapter({
    id: String(extra.channelDbId ?? 1),
    accessToken: "stub",
  });
  return {
    channelDbId: 1,
    tenantId: 1,
    tenantSlug: SLUG,
    tenantPlan: "free",
    kind: "max",
    externalId: BOT_ID,
    adapter,
    maxWebhookSecret: SECRET,
    ...extra,
  };
}

function seedMax(channels: ChannelRegistry, extra: Partial<ChannelEntry> = {}): void {
  // biome-ignore lint/suspicious/noExplicitAny: test seed for private map
  (channels as any).byTenantSlug.set(SLUG, [makeMaxEntry(extra)]);
}

function seedMaxEntries(channels: ChannelRegistry, entries: Partial<ChannelEntry>[]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test seed for private map
  (channels as any).byTenantSlug.set(
    SLUG,
    entries.map((extra) => makeMaxEntry(extra)),
  );
}

function buildApp(opts: { seed?: Partial<ChannelEntry> | false; webhookSecret?: string } = {}) {
  const metrics = makePlatformMetrics();
  const channels = new ChannelRegistry();
  if (opts.seed !== false) seedMax(channels, opts.seed ?? {});
  const routes = makeMaxWebhookRoutes({
    // biome-ignore lint/suspicious/noExplicitAny: db is not used in gate-only tests
    db: {} as any,
    channels,
    ...(opts.webhookSecret ? { webhookSecret: opts.webhookSecret } : {}),
    metrics,
  });
  return { routes, metrics };
}

describe("webhook-max", () => {
  it("unknown slug returns 404 before payload processing", async () => {
    const { routes } = buildApp({ seed: false });
    const res = await routes.request("/webhook/max/nope", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Max-Bot-Api-Secret": SECRET },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("secret mismatch returns 401", async () => {
    const { routes, metrics } = buildApp();
    const res = await routes.request(`/webhook/max/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Max-Bot-Api-Secret": "wrong" },
      body: JSON.stringify({ update_type: "bot_started", timestamp: 1 }),
    });
    expect(res.status).toBe(401);
    expect(metrics.registry.format()).toContain(
      'lead_engine_webhook_requests_total{channel="max",status="401"} 1',
    );
  });

  it("unsupported event with valid secret returns ok", async () => {
    const { routes } = buildApp();
    const res = await routes.request(`/webhook/max/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Max-Bot-Api-Secret": SECRET },
      body: JSON.stringify({ update_type: "bot_started", timestamp: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 0 });
  });

  it("botId route selects the matching channel when secrets overlap", async () => {
    const metrics = makePlatformMetrics();
    const channels = new ChannelRegistry();
    seedMaxEntries(channels, [
      { channelDbId: 1, externalId: "778899", maxWebhookSecret: "shared-secret" },
      { channelDbId: 2, externalId: "889900", maxWebhookSecret: "shared-secret" },
    ]);
    const routes = makeMaxWebhookRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: db is not used in gate-only tests
      db: {} as any,
      channels,
      metrics,
    });

    const res = await routes.request(`/webhook/max/${SLUG}/889900`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Max-Bot-Api-Secret": "shared-secret" },
      body: JSON.stringify({ update_type: "bot_started", timestamp: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 0 });

    const missing = await routes.request(`/webhook/max/${SLUG}/000000`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Max-Bot-Api-Secret": "shared-secret" },
      body: JSON.stringify({ update_type: "bot_started", timestamp: 1 }),
    });
    expect(missing.status).toBe(404);
  });

  it("message_created with no parsable parts returns ok without touching db", async () => {
    const { routes } = buildApp();
    const res = await routes.request(`/webhook/max/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Max-Bot-Api-Secret": SECRET },
      body: JSON.stringify({
        update_type: "message_created",
        timestamp: 1,
        message: {
          sender: { user_id: 1, is_bot: false },
          recipient: { chat_id: 1, chat_type: "dialog" },
          timestamp: 1,
          body: { mid: "m1", text: "" },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 0 });
  });
});
