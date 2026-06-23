import { VkAdapter } from "@chatman-media/channel-vk";
import { makePlatformMetrics } from "@chatman-media/observability";
import { describe, expect, it } from "bun:test";
import { type ChannelEntry, ChannelRegistry } from "../channel-registry.ts";
import { makeVkWebhookRoutes } from "./webhook-vk.ts";

const SLUG = "vk-tenant";
const GROUP_ID = "123456789";
const CONFIRMATION = "vk-confirm-code";
const SECRET = "vk-secret";

function seedVk(channels: ChannelRegistry, extra: Partial<ChannelEntry> = {}): void {
  const adapter = new VkAdapter({ id: "1", accessToken: "stub" });
  const entry: ChannelEntry = {
    channelDbId: 1,
    tenantId: 1,
    tenantSlug: SLUG,
    tenantPlan: "free",
    kind: "vk",
    externalId: GROUP_ID,
    adapter,
    vkConfirmationCode: CONFIRMATION,
    vkSecretKey: SECRET,
    ...extra,
  };
  // biome-ignore lint/suspicious/noExplicitAny: test seed for private map
  (channels as any).byTenantSlug.set(SLUG, [entry]);
}

function buildApp(opts: { seed?: Partial<ChannelEntry> | false; secretKey?: string } = {}) {
  const metrics = makePlatformMetrics();
  const channels = new ChannelRegistry();
  if (opts.seed !== false) seedVk(channels, opts.seed ?? {});
  const routes = makeVkWebhookRoutes({
    // biome-ignore lint/suspicious/noExplicitAny: db is not used in gate-only tests
    db: {} as any,
    channels,
    ...(opts.secretKey ? { secretKey: opts.secretKey } : {}),
    metrics,
  });
  return { routes, metrics };
}

describe("webhook-vk", () => {
  it("confirmation returns tenant confirmation code as plaintext", async () => {
    const { routes } = buildApp();
    const res = await routes.request(`/webhook/vk/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "confirmation", group_id: Number(GROUP_ID) }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONFIRMATION);
  });

  it("unknown slug returns 404 before payload processing", async () => {
    const { routes } = buildApp({ seed: false });
    const res = await routes.request("/webhook/vk/nope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "confirmation", group_id: Number(GROUP_ID) }),
    });
    expect(res.status).toBe(404);
  });

  it("unknown group_id returns 404", async () => {
    const { routes } = buildApp();
    const res = await routes.request(`/webhook/vk/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "message_new", group_id: 999, secret: SECRET }),
    });
    expect(res.status).toBe(404);
  });

  it("secret mismatch returns 401 for non-confirmation callbacks", async () => {
    const { routes, metrics } = buildApp();
    const res = await routes.request(`/webhook/vk/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message_new",
        group_id: Number(GROUP_ID),
        secret: "wrong",
        object: { message: { id: 1, peer_id: 555, text: "" } },
      }),
    });
    expect(res.status).toBe(401);
    expect(metrics.registry.format()).toContain(
      'lead_engine_webhook_requests_total{channel="vk",status="401"} 1',
    );
  });

  it("unsupported event with valid secret returns ok", async () => {
    const { routes } = buildApp();
    const res = await routes.request(`/webhook/vk/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message_typing_state",
        group_id: Number(GROUP_ID),
        secret: SECRET,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("message_new with no parsable parts returns ok without touching db", async () => {
    const { routes } = buildApp();
    const res = await routes.request(`/webhook/vk/${SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message_new",
        group_id: Number(GROUP_ID),
        secret: SECRET,
        object: { message: { id: 1, peer_id: 555, text: "" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
