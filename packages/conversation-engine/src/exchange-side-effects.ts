// Exchange side-effects оператор-бота, вынесенные из operator-bot-handler.ts.
// Чистые транзакционные операции над exchange_orders: принимают tx + draft,
// возвращают result-объект для аудита. Тестируются изолированно (fake tx).

import { and, desc, eq } from "drizzle-orm";
import { exchangeOrders } from "@chatman-media/storage";
import type { Db } from "./dal/types.ts";
import {
	PAYOUT_CODE_TTL_SEC,
	type PendingOperatorDraft,
	pickupWindowFromDestination,
	stringValue,
} from "./operator-bot-shared.ts";

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

	const terminal = new Set([
		"paid",
		"payout",
		"completed",
		"cancelled",
		"expired",
	]);
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
		.where(
			and(
				eq(exchangeOrders.tenantId, draft.tenantId),
				eq(exchangeOrders.id, order.id),
			),
		);
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
	const code =
		order.payoutCode ?? metadataCode ?? createPayoutCode(order.id);
	const metadataExpiresAt = numericMetadata(
		draft.metadata?.payoutCodeExpiresAt,
	);
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
		.where(
			and(
				eq(exchangeOrders.tenantId, draft.tenantId),
				eq(exchangeOrders.id, order.id),
			),
		);
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


export function metadataOrderId(
	metadata: Record<string, unknown> | undefined,
): number | null {
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

