import { describe, expect, it } from "bun:test";
import { buildExchangeOperatorHandoff, parsePickupWindow } from "./exchange-operator-handoff.ts";
import type { ExchangePolicyState } from "./exchange-policy-guard.ts";

const STATE: ExchangePolicyState = {
	stageSlug: "payment_review",
	verification: {
		verified: true,
		status: "verified",
		needsVerification: false,
		verificationId: "operator-bot-109-123",
	},
	order: {
		id: 77,
		status: "awaiting_payment",
		assetFrom: "RUB",
		network: "",
		amountMode: "source_amount",
		requestedAmount: 100000,
		amountFrom: 100000,
		rate: 0.38,
		amountToThb: 38000,
		paymentMethod: "bank_transfer",
		paymentRail: "sber",
		payoutMethod: "office_cash",
		payoutLocation: "Bangkok Asok",
		payoutDestinationJson: JSON.stringify({ pickupWindow: "15:00-16:00" }),
		requisitesIssued: true,
		paymentProofReceived: true,
		paymentVerified: false,
		payoutReady: false,
		payoutCompleted: false,
		payoutCodeIssued: false,
		verificationId: "operator-bot-109-123",
	},
};

describe("buildExchangeOperatorHandoff", () => {
	it("turns fiat payment receipt review into an order-scoped payment handoff", () => {
		const handoff = buildExchangeOperatorHandoff({
			text: "Чек получили, передаю оператору на проверку.",
			state: STATE,
			telemetry: {
				toolCalls: [
					{
						name: "verify_exchange_payment",
						args: { proof: "receipt" },
						result: {
							orderId: 77,
							ok: false,
							needsOperator: true,
							sourceBank: "sber",
							receiptAmount: 100000,
						},
						cycle: 1,
					},
				],
			},
		});

		expect(handoff).toMatchObject({
			reason: "payment_review",
			orderId: 77,
			stageSlug: "payment_review",
			pending: "operator_payment_review",
			amount: "100000",
			rail: "sber",
		});
		expect(handoff?.context).toContain("100000 RUB");
		expect(handoff?.reviewPath).toContain("payment_confirmed");
	});

	it("turns office payout needsOperator into office confirmation handoff", () => {
		const handoff = buildExchangeOperatorHandoff({
			text: "Код выдачи подготовит оператор.",
			state: { ...STATE, stageSlug: "payout" },
			telemetry: {
				toolCalls: [
					{
						name: "issue_exchange_payout",
						args: { payoutMethod: "office_cash", location: "Bangkok Asok" },
						result: {
							orderId: 77,
							needsOperator: true,
							location: "Bangkok Asok",
							pickupWindow: "15:00-16:00",
						},
						cycle: 1,
					},
				],
			},
		});

		expect(handoff).toMatchObject({
			reason: "office_payout",
			orderId: 77,
			pending: "operator_office_confirmation",
		});
		expect(handoff?.context).toContain("office=Bangkok Asok");
		expect(handoff?.context).toContain("pickup_window=15:00-16:00");
		expect(handoff?.reviewPath).toContain("office_details");
	});

	it("turns KYC verification block into KYC decision handoff", () => {
		const handoff = buildExchangeOperatorHandoff({
			text: "Для обмена нужна верификация. Передаю документы оператору.",
			state: {
				...STATE,
				stageSlug: "kyc_collection",
				verification: {
					verified: false,
					status: "pending",
					needsVerification: true,
				},
			},
			telemetry: {
				toolCalls: [
					{
						name: "check_exchange_verification",
						args: {},
						result: {
							verified: false,
							needsVerification: true,
							status: "pending",
						},
						cycle: 1,
					},
				],
			},
		});

		expect(handoff).toMatchObject({
			reason: "kyc_review",
			orderId: 77,
			stageSlug: "kyc_collection",
			pending: "operator_kyc_decision",
		});
		expect(handoff?.reviewPath).toContain("kyc_approved");
	});
});

describe("parsePickupWindow", () => {
	it("accepts common destination keys", () => {
		expect(parsePickupWindow('{"pickupWindow":"15:00-16:00"}')).toBe(
			"15:00-16:00",
		);
		expect(parsePickupWindow('{"time_window":"after 18:00"}')).toBe(
			"after 18:00",
		);
		expect(parsePickupWindow("not-json")).toBeNull();
	});
});
