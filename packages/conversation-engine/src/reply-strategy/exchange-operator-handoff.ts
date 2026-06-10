import type { OperatorHandoffMeta } from "@chatman-media/channel-core";
import type { AnswerTelemetry } from "@chatman-media/kb";
import type { ExchangeOrderPolicyState, ExchangePolicyState } from "./exchange-policy-guard.ts";

type ToolTelemetry = Pick<AnswerTelemetry, "toolCall" | "toolCalls"> | null | undefined;

interface ExchangeOperatorHandoffInput {
	text: string;
	telemetry?: ToolTelemetry;
	state?: ExchangePolicyState | null;
}

function toolCalls(telemetry: ToolTelemetry) {
	return (
		telemetry?.toolCalls ??
		(telemetry?.toolCall ? [{ ...telemetry.toolCall, args: {}, cycle: 0 }] : [])
	);
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function resultObject(value: unknown): Record<string, unknown> | null {
	return objectValue(value);
}

function resultNeedsOperator(result: Record<string, unknown> | null): boolean {
	if (!result) return false;
	return (
		result.needsOperator === true ||
		result.needsVerification === true ||
		result.ok === false ||
		typeof result.error === "string"
	);
}

function amountLabel(order: ExchangeOrderPolicyState | null | undefined): string {
	if (!order) return "";
	const parts = [
		order.amountFrom ? `${order.amountFrom} ${order.assetFrom ?? ""}`.trim() : "",
		order.amountToThb ? `${order.amountToThb} THB` : "",
	].filter(Boolean);
	return parts.join(" → ");
}

function routeLabel(order: ExchangeOrderPolicyState | null | undefined): string {
	if (!order) return "";
	return [
		order.paymentRail ? `rail=${order.paymentRail}` : "",
		order.network ? `network=${order.network}` : "",
		order.payoutMethod ? `payout=${order.payoutMethod}` : "",
		order.payoutLocation ? `location=${order.payoutLocation}` : "",
	]
		.filter(Boolean)
		.join(", ");
}

export function parsePickupWindow(value: string | null | undefined): string | null {
	if (!value?.trim()) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		const obj = objectValue(parsed);
		if (!obj) return null;
		return (
			stringValue(obj.pickupWindow) ??
			stringValue(obj.pickup_window) ??
			stringValue(obj.window) ??
			stringValue(obj.timeWindow) ??
			stringValue(obj.time_window) ??
			stringValue(obj.slot)
		);
	} catch {
		return null;
	}
}

function buildKycHandoff(
	state: ExchangePolicyState | null | undefined,
): OperatorHandoffMeta {
	const order = state?.order ?? null;
	return {
		reason: "kyc_review",
		title: "Проверить KYC клиента",
		action:
			"Проверить документ/фото/видео клиента, принять решение: KYC OK, запросить материалы или отклонить.",
		priority: "high",
		...(order?.id ? { orderId: order.id } : {}),
		...(state?.stageSlug ? { stageSlug: state.stageSlug } : {}),
		pending: "operator_kyc_decision",
		reviewPath: "operator_bot: kyc_approved / kyc_request_materials / kyc_rejected",
		context: [
			state?.verification?.status
				? `verification=${state.verification.status}`
				: "",
			amountLabel(order),
			routeLabel(order),
		]
			.filter(Boolean)
			.join("; "),
	};
}

function buildPaymentHandoff(
	state: ExchangePolicyState | null | undefined,
	toolResult: Record<string, unknown> | null,
): OperatorHandoffMeta {
	const order = state?.order ?? null;
	const receiptAmount =
		numberValue(toolResult?.receiptAmount) ?? numberValue(toolResult?.amount);
	return {
		reason: "payment_review",
		title: "Проверить оплату по заявке",
		action:
			"Сверить чек/поступление, сумму, банк/rail и отправителя. После проверки подтвердить оплату или отметить проблему.",
		priority: "high",
		...(order?.id ? { orderId: order.id } : {}),
		...(state?.stageSlug ? { stageSlug: state.stageSlug } : {}),
		pending: "operator_payment_review",
		reviewPath: "operator_bot: payment_confirmed / payment_under_review / payment_problem",
		amount: receiptAmount
			? String(receiptAmount)
			: amountLabel(order),
		rail:
			stringValue(toolResult?.sourceBank) ??
			order?.paymentRail ??
			order?.paymentMethod ??
			"",
		network: order?.network ?? "",
		context: [amountLabel(order), routeLabel(order)].filter(Boolean).join("; "),
	};
}

function buildOfficeHandoff(
	state: ExchangePolicyState | null | undefined,
	toolResult: Record<string, unknown> | null,
): OperatorHandoffMeta {
	const order = state?.order ?? null;
	const location =
		stringValue(toolResult?.location) ??
		stringValue(toolResult?.payoutLocation) ??
		order?.payoutLocation ??
		"";
	const pickupWindow =
		stringValue(toolResult?.pickupWindow) ??
		parsePickupWindow(order?.payoutDestinationJson);
	return {
		reason: "office_payout",
		title: "Подтвердить выдачу в офисе",
		action:
			"Подтвердить выбранный офис, окно получения, наличие THB/код выдачи и отправить клиенту финальные инструкции.",
		priority: "high",
		...(order?.id ? { orderId: order.id } : {}),
		...(state?.stageSlug ? { stageSlug: state.stageSlug } : {}),
		accepted: "payment_verified_or_payout_pending",
		pending: "operator_office_confirmation",
		reviewPath: "operator_bot: office_details / payout_ready",
		context: [
			location ? `office=${location}` : "",
			pickupWindow ? `pickup_window=${pickupWindow}` : "",
			routeLabel(order),
		]
			.filter(Boolean)
			.join("; "),
		amount: amountLabel(order),
	};
}

export function buildExchangeOperatorHandoff(
	input: ExchangeOperatorHandoffInput,
): OperatorHandoffMeta | null {
	const state = input.state ?? null;
	const order = state?.order ?? null;
	let fallbackPaymentResult: Record<string, unknown> | null = null;
	let fallbackOfficeResult: Record<string, unknown> | null = null;

	for (const call of toolCalls(input.telemetry).slice().reverse()) {
		const result = resultObject(call.result);
		if (!resultNeedsOperator(result)) continue;

		if (
			call.name === "check_exchange_verification" ||
			(call.name === "create_exchange_order" && result?.needsVerification === true)
		) {
			return buildKycHandoff(state);
		}
		if (call.name === "verify_exchange_payment") {
			return buildPaymentHandoff(state, result);
		}
		if (call.name === "issue_exchange_payout") {
			return buildOfficeHandoff(state, result);
		}
		if (!fallbackPaymentResult && result?.needsOperator === true) {
			fallbackPaymentResult = result;
		}
	}

	const text = input.text.toLowerCase();
	if (
		order?.paymentProofReceived === true &&
		order.paymentVerified !== true &&
		/(?:чек|оплат|receipt|proof|плат[её]ж)/iu.test(text)
	) {
		return buildPaymentHandoff(state, fallbackPaymentResult);
	}
	if (
		order?.payoutMethod === "office_cash" &&
		order.payoutCodeIssued !== true &&
		/(?:офис|выдач|получ|код|office|pickup)/iu.test(text)
	) {
		return buildOfficeHandoff(state, fallbackOfficeResult);
	}
	if (
		state?.verification?.verified !== true &&
		/(?:верификац|kyc|документ|паспорт|видео|кружок|селфи)/iu.test(text)
	) {
		return buildKycHandoff(state);
	}

	return null;
}
