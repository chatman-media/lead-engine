// Exchange side-effects оператор-бота, вынесенные из operator-bot-handler.ts.
// Чистые транзакционные операции над exchange_orders: принимают tx + draft,
// возвращают result-объект для аудита. Тестируются изолированно (fake tx).

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  adminNotifications,
  contacts,
  exchangeOrders,
  funnels,
  leadEvents,
  leads,
  stageDefinitions,
} from "@chatman-media/storage";
import type { Db } from "./dal/types.ts";
import {
  objectValue,
  parseJsonObject,
  PAYOUT_CODE_TTL_SEC,
  type PendingOperatorDraft,
  pickupWindowFromDestination,
  stringValue,
} from "./operator-bot-shared.ts";

const EXCHANGE_VERTICAL_TEMPLATE_ID = "exchange_v1";
const EXCHANGE_REQUEST_TYPE = "exchange";

export async function findExchangeOrderForDraft(
  tx: Db,
  draft: PendingOperatorDraft,
): Promise<{
  id: number;
  leadId: number | null;
  status: string;
  payoutCode: string | null;
  payoutCodeExpiresAt: number | null;
  verificationId: string | null;
  payoutMethod: string | null;
  payoutLocation: string | null;
  payoutDestinationJson: string | null;
} | null> {
  const orderId = metadataOrderId(draft.metadata);
  const selection = {
    id: exchangeOrders.id,
    leadId: exchangeOrders.leadId,
    status: exchangeOrders.status,
    payoutCode: exchangeOrders.payoutCode,
    payoutCodeExpiresAt: exchangeOrders.payoutCodeExpiresAt,
    verificationId: exchangeOrders.verificationId,
    payoutMethod: exchangeOrders.payoutMethod,
    payoutLocation: exchangeOrders.payoutLocation,
    payoutDestinationJson: exchangeOrders.payoutDestinationJson,
  };
  if (orderId) {
    const [order] = await tx
      .select(selection)
      .from(exchangeOrders)
      .where(
        and(
          eq(exchangeOrders.tenantId, draft.tenantId),
          eq(exchangeOrders.conversationId, draft.conversationId),
          eq(exchangeOrders.id, orderId),
        ),
      )
      .limit(1);
    return order ?? null;
  }
  const [order] = await tx
    .select(selection)
    .from(exchangeOrders)
    .where(
      and(
        eq(exchangeOrders.tenantId, draft.tenantId),
        eq(exchangeOrders.conversationId, draft.conversationId),
      ),
    )
    .orderBy(desc(exchangeOrders.createdAt))
    .limit(1);
  return order ?? null;
}

export async function applyPaymentConfirmedSideEffect(
  tx: Db,
  draft: PendingOperatorDraft,
  now: number,
): Promise<Record<string, unknown>> {
  const orderId = metadataOrderId(draft.metadata);
  const order = await findExchangeOrderForDraft(tx, draft);
  if (!order) {
    return {
      action: "payment_confirmed",
      ...(orderId ? { orderId } : {}),
      orderFound: false,
      statusPatched: false,
    };
  }

  const terminal = new Set(["paid", "payout", "completed", "cancelled", "expired"]);
  if (terminal.has(order.status)) {
    return {
      action: "payment_confirmed",
      orderId: order.id,
      previousStatus: order.status,
      statusPatched: false,
    };
  }

  await tx
    .update(exchangeOrders)
    .set({ status: "paid", updatedAt: now })
    .where(and(eq(exchangeOrders.tenantId, draft.tenantId), eq(exchangeOrders.id, order.id)));
  return {
    action: "payment_confirmed",
    orderId: order.id,
    previousStatus: order.status,
    nextStatus: "paid",
    statusPatched: true,
  };
}

export async function applyPayoutReadySideEffect(
  tx: Db,
  draft: PendingOperatorDraft,
  now: number,
): Promise<Record<string, unknown>> {
  const orderId = metadataOrderId(draft.metadata);
  const order = await findExchangeOrderForDraft(tx, draft);
  if (!order) {
    return {
      action: "payout_ready",
      ...(orderId ? { orderId } : {}),
      orderFound: false,
      statusPatched: false,
    };
  }
  if (order.status !== "paid" && order.status !== "payout") {
    return {
      action: "payout_ready",
      orderId: order.id,
      previousStatus: order.status,
      statusPatched: false,
      reason: "invalid_status",
    };
  }

  const metadataCode = stringValue(draft.metadata?.payoutCode);
  const code = order.payoutCode ?? metadataCode ?? createPayoutCode(order.id);
  const metadataExpiresAt = numericMetadata(draft.metadata?.payoutCodeExpiresAt);
  const expiresAt =
    order.payoutCodeExpiresAt && order.payoutCodeExpiresAt > now
      ? order.payoutCodeExpiresAt
      : metadataExpiresAt && metadataExpiresAt > now
        ? metadataExpiresAt
        : now + PAYOUT_CODE_TTL_SEC;
  await tx
    .update(exchangeOrders)
    .set({
      status: "payout",
      payoutCode: code,
      payoutCodeExpiresAt: expiresAt,
      updatedAt: now,
    })
    .where(and(eq(exchangeOrders.tenantId, draft.tenantId), eq(exchangeOrders.id, order.id)));
  return {
    action: "payout_ready",
    orderId: order.id,
    previousStatus: order.status,
    nextStatus: "payout",
    payoutCodeIssued: true,
    statusPatched: order.status !== "payout",
  };
}

export async function applyOfficeDetailsSideEffect(
  tx: Db,
  draft: PendingOperatorDraft,
): Promise<Record<string, unknown>> {
  const orderId = metadataOrderId(draft.metadata);
  const order = await findExchangeOrderForDraft(tx, draft);
  if (!order) {
    return {
      action: "office_details",
      ...(orderId ? { orderId } : {}),
      orderFound: false,
      confirmationState: "not_recorded",
    };
  }
  const pickupWindow =
    stringValue(draft.metadata?.pickupWindow) ??
    pickupWindowFromDestination(order.payoutDestinationJson);
  return {
    action: "office_details",
    orderId: order.id,
    confirmationState: "operator_confirmed",
    payoutMethod: order.payoutMethod,
    payoutLocation: order.payoutLocation,
    ...(pickupWindow ? { pickupWindow } : {}),
    statusPatched: false,
  };
}

export function metadataOrderId(metadata: Record<string, unknown> | undefined): number | null {
  const raw = metadata?.orderId;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function numericMetadata(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function createPayoutCode(orderId: number): string {
  const suffix =
    globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 6) ??
    Math.random().toString(36).slice(2, 8);
  return `CODE-${orderId}-${suffix.toUpperCase()}`;
}

export async function applyExchangeDraftSideEffects(
  tx: Db,
  draft: PendingOperatorDraft,
  now: number,
  contactId: number,
): Promise<Record<string, unknown> | null> {
  const action = stringValue(draft.metadata?.exchangeAction);
  if (
    action === "kyc_approved" ||
    action === "kyc_request_materials" ||
    action === "kyc_rejected"
  ) {
    return applyKycDecisionSideEffect(tx, draft, now, contactId, action);
  }
  if (action === "payment_confirmed") {
    return applyPaymentConfirmedSideEffect(tx, draft, now);
  }
  if (action === "payout_ready") {
    return applyPayoutReadySideEffect(tx, draft, now);
  }
  if (action === "office_details") {
    return applyOfficeDetailsSideEffect(tx, draft);
  }
  return null;
}

export async function applyKycDecisionSideEffect(
  tx: Db,
  draft: PendingOperatorDraft,
  now: number,
  contactId: number,
  action: "kyc_approved" | "kyc_request_materials" | "kyc_rejected",
): Promise<Record<string, unknown>> {
  const decision =
    action === "kyc_approved"
      ? {
          status: "verified",
          verified: true,
          needsVerification: false,
        }
      : action === "kyc_rejected"
        ? {
            status: "rejected",
            verified: false,
            needsVerification: true,
          }
        : {
            status: "materials_requested",
            verified: false,
            needsVerification: true,
          };
  const [contact] = await tx
    .select({ attributesJson: contacts.attributesJson })
    .from(contacts)
    .where(and(eq(contacts.tenantId, draft.tenantId), eq(contacts.id, contactId)))
    .limit(1);
  if (!contact) {
    return {
      action,
      contactId,
      contactFound: false,
      statusPatched: false,
    };
  }

  const attrs = parseJsonObject(contact.attributesJson);
  const currentKyc = objectValue(attrs.exchangeKyc);
  const existingVerificationId = stringValue(currentKyc.verificationId);
  const verificationId = decision.verified
    ? (existingVerificationId ?? `operator-bot-${draft.conversationId}-${now}`)
    : null;
  const nextKyc = {
    ...currentKyc,
    status: decision.status,
    verified: decision.verified,
    needsVerification: decision.needsVerification,
    verificationId,
    reviewedByAdminId: draft.adminId,
    reviewedAt: now,
    source: "operator_bot",
  };
  const nextAttrs = {
    ...attrs,
    exchangeKyc: nextKyc,
    verificationStatus: decision.status,
    kycStatus: decision.status,
    isVerified: decision.verified,
  };

  await tx
    .update(contacts)
    .set({
      attributesJson: JSON.stringify(nextAttrs),
      updatedAt: now,
    })
    .where(and(eq(contacts.tenantId, draft.tenantId), eq(contacts.id, contactId)));

  let orderId: number | null = null;
  let orderVerificationPatched = false;
  const order = await findExchangeOrderForDraft(tx, draft);
  if (order) {
    orderId = order.id;
    const patchableStatuses = new Set(["quote", "awaiting_payment"]);
    const nextOrderVerificationId = decision.verified ? verificationId : null;
    if (patchableStatuses.has(order.status) && order.verificationId !== nextOrderVerificationId) {
      await tx
        .update(exchangeOrders)
        .set({
          verificationId: nextOrderVerificationId,
          updatedAt: now,
        })
        .where(and(eq(exchangeOrders.tenantId, draft.tenantId), eq(exchangeOrders.id, order.id)));
      orderVerificationPatched = true;
    }
  }

  const leadAdvance = decision.verified
    ? await advanceExchangeLeadAfterKycApproved(tx, draft, now, contactId, order?.leadId ?? null)
    : null;

  await tx
    .update(adminNotifications)
    .set({ readAt: now })
    .where(
      and(
        eq(adminNotifications.tenantId, draft.tenantId),
        inArray(adminNotifications.dedupKey, [
          `operator_handoff_required:${draft.conversationId}`,
          `verification_requested:${draft.conversationId}`,
          `document_uploaded:${draft.conversationId}`,
        ]),
        isNull(adminNotifications.readAt),
      ),
    );

  return {
    action,
    contactId,
    status: decision.status,
    verified: decision.verified,
    verificationId,
    statusPatched: true,
    ...(orderId ? { orderId, orderVerificationPatched } : {}),
    ...(leadAdvance ? { leadAdvance } : {}),
  };
}

export async function advanceExchangeLeadAfterKycApproved(
  tx: Db,
  draft: PendingOperatorDraft,
  now: number,
  contactId: number,
  orderLeadId: number | null,
): Promise<Record<string, unknown>> {
  const leadFilter = orderLeadId != null ? eq(leads.id, orderLeadId) : eq(leads.userId, contactId);
  const [lead] = await tx
    .select({
      id: leads.id,
      state: leads.state,
      stageDefinitionId: leads.stageDefinitionId,
      stageSlug: stageDefinitions.slug,
      stageFunnelId: stageDefinitions.funnelId,
      stagePosition: stageDefinitions.position,
      stageNextStages: stageDefinitions.nextStages,
    })
    .from(leads)
    .leftJoin(stageDefinitions, eq(leads.stageDefinitionId, stageDefinitions.id))
    .where(and(eq(leads.tenantId, draft.tenantId), leadFilter))
    .orderBy(desc(leads.updatedAt), desc(leads.id))
    .limit(1);
  if (!lead) {
    return {
      advanced: false,
      reason: "lead_not_found",
      ...(orderLeadId != null ? { leadId: orderLeadId } : {}),
    };
  }

  const currentSlug = lead.stageSlug ?? lead.state;
  if (currentSlug !== "verification_check" && currentSlug !== "kyc_collection") {
    const [target] = await tx
      .select({
        id: stageDefinitions.id,
        slug: stageDefinitions.slug,
      })
      .from(stageDefinitions)
      .innerJoin(funnels, eq(stageDefinitions.funnelId, funnels.id))
      .where(
        and(
          eq(stageDefinitions.tenantId, draft.tenantId),
          eq(stageDefinitions.slug, "risk_review"),
          eq(funnels.tenantId, draft.tenantId),
          eq(funnels.isActive, true),
          eq(funnels.verticalTemplateId, EXCHANGE_VERTICAL_TEMPLATE_ID),
        ),
      )
      .limit(1);
    if (target) {
      await tx
        .update(leads)
        .set({
          stageDefinitionId: target.id,
          state: target.slug,
          requestType: EXCHANGE_REQUEST_TYPE,
          updatedAt: now,
        })
        .where(and(eq(leads.tenantId, draft.tenantId), eq(leads.id, lead.id)));
      await tx.insert(leadEvents).values({
        tenantId: draft.tenantId,
        leadId: lead.id,
        fromState: lead.state,
        toState: target.slug,
        byAdminId: draft.adminId,
        notes: JSON.stringify({
          type: "operator_bot_kyc_approved_recovered_exchange_stage",
          conversationId: draft.conversationId,
          fromStage: currentSlug,
        }),
        createdAt: now,
      });
      return {
        leadId: lead.id,
        advanced: true,
        recovered: true,
        reason: "recovered_wrong_stage",
        fromState: lead.state,
        toState: target.slug,
        stageDefinitionId: target.id,
      };
    }
    return {
      leadId: lead.id,
      advanced: false,
      reason: "stage_not_eligible",
      stage: currentSlug,
    };
  }
  if (lead.stageFunnelId == null || lead.stagePosition == null) {
    return {
      leadId: lead.id,
      advanced: false,
      reason: "stage_context_missing",
      stage: currentSlug,
    };
  }
  const nextStages = lead.stageNextStages ?? [];
  if (nextStages.length > 0 && !nextStages.includes("risk_review")) {
    return {
      leadId: lead.id,
      advanced: false,
      reason: "transition_not_allowed",
      stage: currentSlug,
    };
  }

  const [target] = await tx
    .select({
      id: stageDefinitions.id,
      slug: stageDefinitions.slug,
      position: stageDefinitions.position,
    })
    .from(stageDefinitions)
    .where(
      and(
        eq(stageDefinitions.tenantId, draft.tenantId),
        eq(stageDefinitions.funnelId, lead.stageFunnelId),
        eq(stageDefinitions.slug, "risk_review"),
      ),
    )
    .limit(1);
  if (!target) {
    return {
      leadId: lead.id,
      advanced: false,
      reason: "target_stage_not_found",
      stage: currentSlug,
    };
  }
  if (target.position <= lead.stagePosition) {
    return {
      leadId: lead.id,
      advanced: false,
      reason: "target_not_ahead",
      stage: currentSlug,
      targetStage: target.slug,
    };
  }

  await tx
    .update(leads)
    .set({
      stageDefinitionId: target.id,
      state: target.slug,
      requestType: EXCHANGE_REQUEST_TYPE,
      updatedAt: now,
    })
    .where(and(eq(leads.tenantId, draft.tenantId), eq(leads.id, lead.id)));
  await tx.insert(leadEvents).values({
    tenantId: draft.tenantId,
    leadId: lead.id,
    fromState: lead.state,
    toState: target.slug,
    byAdminId: draft.adminId,
    notes: JSON.stringify({
      type: "operator_bot_kyc_approved",
      conversationId: draft.conversationId,
    }),
    createdAt: now,
  });

  return {
    leadId: lead.id,
    advanced: true,
    fromState: lead.state,
    toState: target.slug,
    stageDefinitionId: target.id,
  };
}
