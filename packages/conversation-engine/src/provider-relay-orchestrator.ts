import type {
  ChannelKind,
  OutboundEnvelope,
  WhatsAppOptIn,
  WhatsAppOutboundMeta,
  WhatsAppTemplateCategory,
  WhatsAppTemplateMessage,
} from "@chatman-media/channel-core";
import { channelIdentities, channels, orderEvents, providerProfiles } from "@chatman-media/storage";
import { and, eq, inArray } from "drizzle-orm";
import {
  canTransitionServiceOrder,
  type OrderEventRow,
  OutboundQueueRepo,
  type OutboundQueueRow,
  ProviderRelayRepo,
  type ProviderRequestRow,
  type ServiceOrderRow,
  type ServiceOrderStatus,
  canTransitionProviderRequest,
} from "./dal/index.ts";
import type { RepoCtx } from "./dal/types.ts";
import {
  type ProviderRelayMetrics,
  normalizeMetricLabel,
  providerRelayTenantLabels,
} from "./provider-relay-metrics.ts";
import {
  type ProviderRouteCandidate,
  ProviderRouter,
  type ProviderRoutingFailureReason,
} from "./provider-routing.ts";
import { PROVIDER_RELAY_FEATURE_KEY, TenantFeatureFlagRepo } from "./tenant-feature-flags.ts";

const defaultProviderChannelKinds: ChannelKind[] = [
  "whatsapp",
  "telegram_bot",
  "telegram_userbot",
  "web",
  "facebook",
  "vk",
];

export type ProviderRelayStartFailureReason =
  | "provider_relay_disabled"
  | "routing_failed"
  | "provider_channel_missing";

export interface ProviderChannelIdentity {
  channelDbId: number;
  channelKind: ChannelKind;
  channelExternalId: string;
  externalUserId: string;
  whatsapp?: {
    optIn?: WhatsAppOptIn;
    providerRequestTemplate?: WhatsAppTemplateMessage;
  };
}

export interface ProviderRelayStartInput {
  customerContactId: number;
  requestType: string;
  nowEpoch: number;
  serviceArea?: string | null;
  summary?: string | null;
  customerConversationId?: number | null;
  leadId?: number | null;
  providerIdOverride?: number | null;
  preferredChannelKinds?: ChannelKind[];
  orderIdempotencyKey?: string | null;
  providerRequestIdempotencyKey?: string | null;
  outboundIdempotencyKey?: string | null;
  messageText?: string | null;
  whatsAppTemplateName?: string | null;
  whatsAppTemplateLanguageCode?: string | null;
  metadata?: Record<string, unknown>;
}

export type ProviderRelayStartResult =
  | {
      ok: true;
      order: ServiceOrderRow;
      providerRequest: ProviderRequestRow;
      outbound: OutboundQueueRow;
      envelope: OutboundEnvelope;
      candidate: ProviderRouteCandidate;
      identity: ProviderChannelIdentity;
    }
  | {
      ok: false;
      reason: "provider_relay_disabled";
    }
  | {
      ok: false;
      reason: Exclude<ProviderRelayStartFailureReason, "provider_relay_disabled">;
      order: ServiceOrderRow;
      routingReason?: ProviderRoutingFailureReason;
      providerId?: number;
    };

export interface ProviderRelaySendProviderRequestInput {
  orderId: number;
  nowEpoch: number;
  serviceArea?: string | null;
  summary?: string | null;
  providerIdOverride?: number | null;
  preferredChannelKinds?: ChannelKind[];
  providerRequestIdempotencyKey?: string | null;
  outboundIdempotencyKey?: string | null;
  messageText?: string | null;
  whatsAppTemplateName?: string | null;
  whatsAppTemplateLanguageCode?: string | null;
  metadata?: Record<string, unknown>;
}

export type ProviderRelaySendProviderRequestResult =
  | {
      ok: true;
      order: ServiceOrderRow;
      providerRequest: ProviderRequestRow;
      outbound: OutboundQueueRow;
      envelope: OutboundEnvelope;
      candidate: ProviderRouteCandidate;
      identity: ProviderChannelIdentity;
    }
  | {
      ok: false;
      reason: ProviderRelayStartFailureReason | "order_not_found" | "order_not_sendable";
      order?: ServiceOrderRow;
      currentStatus?: ServiceOrderStatus;
      routingReason?: ProviderRoutingFailureReason;
      providerId?: number;
    };

export class ProviderRelayOrchestrator {
  private readonly relay: ProviderRelayRepo;
  private readonly router: ProviderRouter;
  private readonly outbound: OutboundQueueRepo;
  private readonly flags: TenantFeatureFlagRepo;

  constructor(
    private readonly ctx: RepoCtx,
    private readonly opts: { metrics?: ProviderRelayMetrics } = {},
  ) {
    this.relay = new ProviderRelayRepo(ctx);
    this.router = new ProviderRouter(ctx);
    this.outbound = new OutboundQueueRepo(ctx);
    this.flags = new TenantFeatureFlagRepo(ctx);
  }

  async startProviderOutreach(input: ProviderRelayStartInput): Promise<ProviderRelayStartResult> {
    if (!(await this.flags.isEnabled(PROVIDER_RELAY_FEATURE_KEY))) {
      this.recordFailureMetric("none", "provider_relay_disabled");
      return { ok: false, reason: "provider_relay_disabled" };
    }

    const order = await this.relay.createServiceOrder({
      customerContactId: input.customerContactId,
      customerConversationId: input.customerConversationId,
      leadId: input.leadId,
      requestType: input.requestType,
      status: "matching",
      summary: input.summary ?? null,
      idempotencyKey: input.orderIdempotencyKey ?? null,
      metadata:
        input.metadata || input.serviceArea
          ? {
              ...(input.metadata ?? {}),
              ...(input.serviceArea ? { serviceArea: input.serviceArea } : {}),
            }
          : undefined,
      nowEpoch: input.nowEpoch,
    });
    this.opts.metrics?.providerOrdersCreated.inc(1, {
      ...providerRelayTenantLabels(this.ctx.tenantId),
      request_type: normalizeMetricLabel(input.requestType),
    });

    return this.enqueueProviderRequestForOrder({
      order,
      requestType: input.requestType,
      serviceArea: input.serviceArea,
      summary: input.summary,
      providerIdOverride: input.providerIdOverride,
      preferredChannelKinds: input.preferredChannelKinds,
      providerRequestIdempotencyKey: input.providerRequestIdempotencyKey,
      outboundIdempotencyKey: input.outboundIdempotencyKey,
      messageText: input.messageText,
      whatsAppTemplateName: input.whatsAppTemplateName,
      whatsAppTemplateLanguageCode: input.whatsAppTemplateLanguageCode,
      metadata: input.metadata,
      nowEpoch: input.nowEpoch,
    });
  }

  async sendProviderRequestForOrder(
    input: ProviderRelaySendProviderRequestInput,
  ): Promise<ProviderRelaySendProviderRequestResult> {
    if (!(await this.flags.isEnabled(PROVIDER_RELAY_FEATURE_KEY))) {
      this.recordFailureMetric("none", "provider_relay_disabled");
      return { ok: false, reason: "provider_relay_disabled" };
    }

    const order = await this.relay.orderById(input.orderId);
    if (!order) return { ok: false, reason: "order_not_found" };
    if (!canTransitionServiceOrder(order.status, "awaiting_provider")) {
      return {
        ok: false,
        reason: "order_not_sendable",
        order,
        currentStatus: order.status,
      };
    }

    return this.enqueueProviderRequestForOrder({
      order,
      requestType: order.requestType,
      serviceArea:
        input.serviceArea !== undefined
          ? input.serviceArea
          : readString(order.metadataJson, ["serviceArea", "service_area", "area", "location"]),
      summary: input.summary !== undefined ? input.summary : order.summary,
      providerIdOverride:
        input.providerIdOverride !== undefined
          ? input.providerIdOverride
          : order.assignedProviderId,
      preferredChannelKinds: input.preferredChannelKinds,
      providerRequestIdempotencyKey: input.providerRequestIdempotencyKey,
      outboundIdempotencyKey: input.outboundIdempotencyKey,
      messageText: input.messageText,
      whatsAppTemplateName: input.whatsAppTemplateName,
      whatsAppTemplateLanguageCode: input.whatsAppTemplateLanguageCode,
      metadata: input.metadata,
      nowEpoch: input.nowEpoch,
    });
  }

  private async enqueueProviderRequestForOrder(input: {
    order: ServiceOrderRow;
    requestType: string;
    nowEpoch: number;
    serviceArea?: string | null;
    summary?: string | null;
    providerIdOverride?: number | null;
    preferredChannelKinds?: ChannelKind[];
    providerRequestIdempotencyKey?: string | null;
    outboundIdempotencyKey?: string | null;
    messageText?: string | null;
    whatsAppTemplateName?: string | null;
    whatsAppTemplateLanguageCode?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<ProviderRelayStartResult> {
    const { order } = input;
    const route = await this.router.selectProvider({
      serviceType: input.requestType,
      serviceArea: input.serviceArea,
      providerIdOverride: input.providerIdOverride,
    });
    if (!route.ok) {
      await this.relay.appendEvent({
        orderId: order.id,
        actorType: "system",
        eventType: "provider_route_failed",
        data: {
          reason: route.reason,
          ...(route.details ? { details: route.details } : {}),
        },
        nowEpoch: input.nowEpoch,
      });
      this.recordFailureMetric("none", route.reason);
      return {
        ok: false,
        reason: "routing_failed",
        routingReason: route.reason,
        order,
      };
    }

    const identity = await this.resolveProviderChannelIdentity({
      providerId: route.candidate.providerId,
      preferredKinds:
        input.preferredChannelKinds && input.preferredChannelKinds.length > 0
          ? input.preferredChannelKinds
          : defaultProviderChannelKinds,
    });
    if (!identity) {
      await this.relay.appendEvent({
        orderId: order.id,
        actorType: "system",
        eventType: "provider_request_failed",
        data: {
          reason: "provider_channel_missing",
          providerId: route.candidate.providerId,
        },
        nowEpoch: input.nowEpoch,
      });
      this.recordFailureMetric("none", "provider_channel_missing");
      return {
        ok: false,
        reason: "provider_channel_missing",
        order,
        providerId: route.candidate.providerId,
      };
    }

    const outboundKey =
      input.outboundIdempotencyKey ??
      `provider-relay:${order.id}:${route.candidate.providerId}:${identity.channelDbId}:initial`;
    const messageText =
      input.messageText ??
      this.defaultProviderMessage({
        requestType: input.requestType,
        serviceArea: input.serviceArea,
        summary: input.summary,
      });
    const whatsappMeta =
      identity.channelKind === "whatsapp"
        ? this.buildWhatsAppProviderOutreachMeta({
            identity,
            requestType: input.requestType,
            serviceArea: input.serviceArea,
            summary: input.summary,
          })
        : null;
    const envelope: OutboundEnvelope = {
      channelId: String(identity.channelDbId),
      externalUserId: identity.externalUserId,
      parts: [
        {
          kind: "text",
          text: messageText,
        },
      ],
      idempotencyKey: outboundKey,
      ...(whatsappMeta ? { transport: { whatsapp: whatsappMeta } } : {}),
    };

    const outbound = await this.outbound.enqueue({
      channelId: identity.channelDbId,
      conversationId: null,
      envelope,
      nowEpoch: input.nowEpoch,
    });
    const providerRequest = await this.relay.addProviderRequest({
      orderId: order.id,
      providerId: route.candidate.providerId,
      channelId: identity.channelDbId,
      outboundQueueId: outbound.id,
      status: "sent",
      commissionPct: route.candidate.commissionPct,
      idempotencyKey:
        input.providerRequestIdempotencyKey ??
        `provider-request:${order.id}:${route.candidate.providerId}`,
      metadata: {
        ...(input.metadata ?? {}),
        providerServiceId: route.candidate.providerServiceId,
        override: route.override,
      },
      nowEpoch: input.nowEpoch,
    });

    await this.appendProviderRequestEventOnce({
      orderId: order.id,
      providerRequestId: providerRequest.id,
      eventType: "provider_request_sent",
      data: {
        outboundQueueId: outbound.id,
        channelId: identity.channelDbId,
        channelKind: identity.channelKind,
      },
      nowEpoch: input.nowEpoch,
    });
    this.opts.metrics?.providerRequests.inc(1, {
      ...providerRelayTenantLabels(this.ctx.tenantId),
      channel_kind: identity.channelKind,
      status: providerRequest.status,
    });

    const updatedOrder = await this.relay.orderById(order.id);
    return {
      ok: true,
      order: updatedOrder ?? order,
      providerRequest,
      outbound,
      envelope,
      candidate: route.candidate,
      identity,
    };
  }

  private recordFailureMetric(channelKind: string, reason: string): void {
    this.opts.metrics?.providerFailures.inc(1, {
      ...providerRelayTenantLabels(this.ctx.tenantId),
      channel_kind: normalizeMetricLabel(channelKind),
      reason: normalizeMetricLabel(reason),
    });
  }

  async recordDispatchRetry(opts: {
    providerRequestId: number;
    nowEpoch: number;
    error?: string | null;
    outboundQueueId?: number | null;
  }): Promise<OrderEventRow> {
    const request = await this.requireProviderRequest(opts.providerRequestId);
    return this.relay.appendEvent({
      orderId: request.orderId,
      providerRequestId: request.id,
      actorType: "system",
      eventType: "provider_request_retry",
      data: {
        error: opts.error ?? null,
        outboundQueueId: opts.outboundQueueId ?? request.outboundQueueId,
      },
      nowEpoch: opts.nowEpoch,
    });
  }

  async recordDispatchFailed(opts: {
    providerRequestId: number;
    error: string;
    nowEpoch: number;
    outboundQueueId?: number | null;
  }): Promise<OrderEventRow> {
    const request = await this.requireProviderRequest(opts.providerRequestId);
    if (request.status !== "failed" && canTransitionProviderRequest(request.status, "failed")) {
      await this.relay.transitionProviderRequestStatus(request.id, "failed", opts.nowEpoch);
    }
    return this.relay.appendEvent({
      orderId: request.orderId,
      providerRequestId: request.id,
      actorType: "system",
      eventType: "provider_request_send_failed",
      data: {
        error: opts.error,
        outboundQueueId: opts.outboundQueueId ?? request.outboundQueueId,
      },
      nowEpoch: opts.nowEpoch,
    });
  }

  async cancelProviderOutreach(opts: {
    providerRequestId: number;
    reason?: string | null;
    nowEpoch: number;
  }): Promise<ProviderRequestRow> {
    const request = await this.relay.transitionProviderRequestStatus(
      opts.providerRequestId,
      "cancelled",
      opts.nowEpoch,
    );
    await this.relay.appendEvent({
      orderId: request.orderId,
      providerRequestId: request.id,
      actorType: "system",
      eventType: "provider_request_cancelled",
      data: { reason: opts.reason ?? null },
      nowEpoch: opts.nowEpoch,
    });
    return request;
  }

  private async requireProviderRequest(providerRequestId: number): Promise<ProviderRequestRow> {
    const request = await this.relay.providerRequestById(providerRequestId);
    if (!request) {
      throw new Error(`provider request not found: ${providerRequestId}`);
    }
    return request;
  }

  private async appendProviderRequestEventOnce(opts: {
    orderId: number;
    providerRequestId: number;
    eventType: string;
    nowEpoch: number;
    data?: Record<string, unknown>;
  }): Promise<OrderEventRow | null> {
    const [existing] = await this.ctx.db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(
        and(
          eq(orderEvents.tenantId, this.ctx.tenantId),
          eq(orderEvents.providerRequestId, opts.providerRequestId),
          eq(orderEvents.eventType, opts.eventType),
        ),
      )
      .limit(1);
    if (existing) return null;
    return this.relay.appendEvent({
      orderId: opts.orderId,
      providerRequestId: opts.providerRequestId,
      actorType: "system",
      eventType: opts.eventType,
      data: opts.data,
      nowEpoch: opts.nowEpoch,
    });
  }

  private async resolveProviderChannelIdentity(opts: {
    providerId: number;
    preferredKinds: ChannelKind[];
  }): Promise<ProviderChannelIdentity | null> {
    const rows = await this.ctx.db
      .select({
        channelDbId: channelIdentities.channelId,
        channelKind: channels.kind,
        channelExternalId: channels.externalId,
        externalUserId: channelIdentities.externalUserId,
        providerMetadataJson: providerProfiles.metadataJson,
      })
      .from(providerProfiles)
      .innerJoin(channelIdentities, eq(channelIdentities.contactId, providerProfiles.contactId))
      .innerJoin(
        channels,
        and(
          eq(channels.id, channelIdentities.channelId),
          eq(channels.tenantId, this.ctx.tenantId),
          eq(channels.status, "active"),
        ),
      )
      .where(
        and(
          eq(providerProfiles.tenantId, this.ctx.tenantId),
          eq(providerProfiles.id, opts.providerId),
          inArray(channels.kind, opts.preferredKinds),
        ),
      );

    const sorted = rows.sort(
      (a, b) =>
        opts.preferredKinds.indexOf(a.channelKind as ChannelKind) -
        opts.preferredKinds.indexOf(b.channelKind as ChannelKind),
    );
    const row = sorted[0];
    if (!row) return null;
    return {
      channelDbId: row.channelDbId,
      channelKind: row.channelKind as ChannelKind,
      channelExternalId: row.channelExternalId,
      externalUserId: row.externalUserId,
      ...(row.channelKind === "whatsapp"
        ? { whatsapp: readWhatsAppProviderMetadata(row.providerMetadataJson) }
        : {}),
    };
  }

  private buildWhatsAppProviderOutreachMeta(input: {
    identity: ProviderChannelIdentity;
    requestType: string;
    serviceArea?: string | null;
    summary?: string | null;
  }): WhatsAppOutboundMeta {
    const template = input.identity.whatsapp?.providerRequestTemplate;
    return {
      requiresTemplate: true,
      ...(input.identity.whatsapp?.optIn ? { optIn: input.identity.whatsapp.optIn } : {}),
      ...(template
        ? {
            template: {
              ...template,
              components:
                template.components ??
                defaultProviderRequestTemplateComponents({
                  requestType: input.requestType,
                  serviceArea: input.serviceArea,
                  summary: input.summary,
                }),
            },
          }
        : {}),
    };
  }

  private defaultProviderMessage(input: {
    requestType: string;
    serviceArea?: string | null;
    summary?: string | null;
  }): string {
    const lines = [
      `New ${input.requestType} request.`,
      input.serviceArea ? `Area: ${input.serviceArea}` : null,
      input.summary ? `Details: ${input.summary}` : null,
      "Please reply with availability, price, and any constraints.",
    ].filter((line): line is string => Boolean(line));
    return lines.join("\n");
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function isWhatsAppTemplateCategory(value: unknown): value is WhatsAppTemplateCategory {
  return value === "marketing" || value === "utility" || value === "authentication";
}

function readWhatsAppProviderMetadata(metadataJson: string): {
  optIn?: WhatsAppOptIn;
  providerRequestTemplate?: WhatsAppTemplateMessage;
} {
  const metadata = parseJsonObject(metadataJson);
  const optInRaw = parseJsonRecord(metadata.whatsappOptIn);
  const optInSource = cleanString(optInRaw.source);
  const optInAcceptedAt = positiveInt(optInRaw.acceptedAt);
  const optInCategories = Array.isArray(optInRaw.categories)
    ? optInRaw.categories.filter(isWhatsAppTemplateCategory)
    : undefined;

  const providerRequestTemplateRaw = parseJsonRecord(metadata.whatsappProviderRequestTemplate);
  const legacyTemplateRaw = parseJsonRecord(metadata.whatsappTemplate);
  const templateRaw =
    providerRequestTemplateRaw.name || providerRequestTemplateRaw.languageCode
      ? providerRequestTemplateRaw
      : legacyTemplateRaw;
  const templateName = cleanString(templateRaw.name);
  const languageCode = cleanString(templateRaw.languageCode);
  const category = isWhatsAppTemplateCategory(templateRaw.category)
    ? templateRaw.category
    : undefined;
  const approved = templateRaw.approved === true;
  const components = Array.isArray(templateRaw.components)
    ? (templateRaw.components as WhatsAppTemplateMessage["components"])
    : undefined;

  return {
    ...(optInSource && optInAcceptedAt
      ? {
          optIn: {
            source: optInSource,
            acceptedAt: optInAcceptedAt,
            ...(optInCategories && optInCategories.length > 0
              ? { categories: optInCategories }
              : {}),
          },
        }
      : {}),
    ...(templateName && languageCode
      ? {
          providerRequestTemplate: {
            name: templateName,
            languageCode,
            approved,
            ...(category ? { category } : {}),
            ...(components ? { components } : {}),
          },
        }
      : {}),
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function defaultProviderRequestTemplateComponents(input: {
  requestType: string;
  serviceArea?: string | null;
  summary?: string | null;
}): WhatsAppTemplateMessage["components"] {
  return [
    {
      type: "body",
      parameters: [
        { type: "text", text: input.requestType },
        { type: "text", text: input.serviceArea ?? "-" },
        { type: "text", text: input.summary ?? "-" },
      ],
    },
  ];
}

function readString(json: string, keys: string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || "{}");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
