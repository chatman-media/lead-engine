import { describe, expect, it } from "bun:test";
import {
	EXCHANGE_KYC_FALLBACK,
	EXCHANGE_PAYMENT_FALLBACK,
	EXCHANGE_PAYOUT_FALLBACK,
	guardExchangePolicy,
} from "./exchange-policy-guard.ts";
import { EXCHANGE_SAFE_FALLBACK } from "./exchange-reply-guard.ts";

const kycHistory = [
	{
		role: "assistant" as const,
		text: "Для обмена нужно пройти верификацию: пришлите документ и короткое видео/кружок с ФИО.",
	},
];

describe("guardExchangePolicy", () => {
	it("allows KYC handoff wording without pretending verification happened", () => {
		const result = guardExchangePolicy({
			history: kycHistory,
			text: "Принял документ/видео для верификации. Передаю на проверку оператору.",
		});

		expect(result.ok).toBe(true);
		expect(result.text).toContain("Передаю на проверку");
	});

	it("blocks automatic KYC verification claims without verification tool state", () => {
		const result = guardExchangePolicy({
			history: kycHistory,
			text: "Я проверил видео, KYC подтверждён. Продолжаем.",
		});

		expect(result.ok).toBe(false);
		expect(result.action).toBe("escalate");
		expect(result.reason).toBe("kyc_auto_verified");
		expect(result.requiredFixes[0]).toContain("KYC operator handoff");
		expect(result.text).toBe(EXCHANGE_KYC_FALLBACK);
	});

	it("allows KYC verified text only when backed by successful verification tool", () => {
		const result = guardExchangePolicy({
			history: kycHistory,
			text: "KYC подтверждён. Продолжаем оформление заявки.",
			telemetry: {
				toolCalls: [
					{
						name: "check_exchange_verification",
						args: {},
						result: { verified: true, needsVerification: false },
						cycle: 0,
					},
				],
			},
		});

		expect(result.ok).toBe(true);
	});

	it("allows KYC verified text when backed by persisted verification state", () => {
		const result = guardExchangePolicy({
			history: kycHistory,
			text: "KYC подтверждён. Продолжаем оформление заявки.",
			state: {
				verification: {
					verified: true,
					status: "verified",
					needsVerification: false,
					verificationId: "kyc-1",
				},
			},
		});

		expect(result.ok).toBe(true);
	});

	it("does not treat failed verification tool result as KYC backing", () => {
		const result = guardExchangePolicy({
			history: kycHistory,
			text: "KYC подтверждён. Продолжаем оформление заявки.",
			telemetry: {
				toolCalls: [
					{
						name: "check_exchange_verification",
						args: {},
						result: { verified: false, needsVerification: true },
						cycle: 0,
					},
				],
			},
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("kyc_auto_verified");
	});

	it("blocks payment confirmation without payment verification tool", () => {
		const result = guardExchangePolicy({
			text: "Оплата получена и подтверждена, готовлю выдачу.",
		});

		expect(result.ok).toBe(false);
		expect(result.action).toBe("escalate");
		expect(result.reason).toBe("payment_auto_verified");
		expect(result.text).toBe(EXCHANGE_PAYMENT_FALLBACK);
	});

	it("allows payment confirmation when persisted order state is paid", () => {
		const result = guardExchangePolicy({
			text: "Оплата получена и подтверждена, готовлю выдачу.",
			state: {
				order: {
					id: 1,
					status: "paid",
					requisitesIssued: true,
					paymentProofReceived: true,
					paymentVerified: true,
					payoutReady: false,
					payoutCompleted: false,
					payoutCodeIssued: false,
				},
			},
		});

		expect(result.ok).toBe(true);
	});

	it("blocks payout completion without payout tool", () => {
		const result = guardExchangePolicy({
			text: "Выдача готова, деньги можно забирать в офисе.",
		});

		expect(result.ok).toBe(false);
		expect(result.action).toBe("escalate");
		expect(result.reason).toBe("payout_auto_completed");
		expect(result.text).toBe(EXCHANGE_PAYOUT_FALLBACK);
	});

	it("allows payout completion when persisted order has payout code", () => {
		const result = guardExchangePolicy({
			text: "Выдача готова, деньги можно забирать в офисе.",
			state: {
				order: {
					id: 1,
					status: "payout",
					requisitesIssued: true,
					paymentProofReceived: true,
					paymentVerified: true,
					payoutReady: true,
					payoutCompleted: false,
					payoutCodeIssued: true,
				},
			},
		});

		expect(result.ok).toBe(true);
	});

	it("blocks concrete requisites when persisted KYC state still needs verification", () => {
		const result = guardExchangePolicy({
			text: "Реквизиты готовы: оплатите по карте 2200 7000 1234 5678.",
			state: {
				verification: {
					verified: false,
					status: "pending_review",
					needsVerification: true,
					verificationId: null,
				},
			},
			telemetry: {
				toolCalls: [
					{
						name: "fetch_exchange_requisites",
						args: {},
						result: { ok: true },
						cycle: 0,
					},
				],
			},
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("requisites_while_kyc_pending");
	});

	it("blocks concrete requisites even if fetched while KYC is still pending", () => {
		const result = guardExchangePolicy({
			history: kycHistory,
			text: "Реквизиты готовы: оплатите по карте 2200 7000 1234 5678.",
			telemetry: {
				toolCalls: [
					{
						name: "fetch_exchange_requisites",
						args: {},
						result: { ok: true },
						cycle: 0,
					},
				],
			},
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("requisites_while_kyc_pending");
		expect(result.text).toBe(EXCHANGE_SAFE_FALLBACK);
	});

	it("allows fetched requisites after persisted KYC verification despite old KYC history", () => {
		const result = guardExchangePolicy({
			history: kycHistory,
			text: "Реквизиты готовы: оплатите по карте 2200 7000 1234 5678.",
			state: {
				stageSlug: "kyc_collection",
				verification: {
					verified: true,
					status: "verified",
					needsVerification: false,
					verificationId: "operator-bot-109-123",
				},
			},
			telemetry: {
				toolCalls: [
					{
						name: "fetch_exchange_requisites",
						args: {},
						result: { ok: true },
						cycle: 0,
					},
				],
			},
		});

		expect(result.ok).toBe(true);
	});

	it("keeps old factual guard behavior for unbacked quotes", () => {
		const result = guardExchangePolicy({
			text: "Курс 31.5, получите 10553 THB.",
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("unbacked_quote");
		expect(result.text).toBe(EXCHANGE_SAFE_FALLBACK);
	});
});
