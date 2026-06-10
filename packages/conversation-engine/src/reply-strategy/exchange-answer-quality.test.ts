import { describe, expect, it } from "bun:test";
import {
	buildExchangeAnswerQualityContext,
	buildExchangeAnswerQualityDebugPayload,
	type ExchangeResponseContractId,
	exchangeOperatorHandoffForContext,
	formatExchangeAnswerQualityDebugTrace,
	redactExchangeDebugText,
} from "./exchange-answer-quality.ts";
import type {
	ExchangeOrderPolicyState,
	ExchangePolicyState,
} from "./exchange-policy-guard.ts";
import { guardExchangePolicy } from "./exchange-policy-guard.ts";

const pendingKycState: ExchangePolicyState = {
	stageSlug: "verification_check",
	verification: {
		verified: false,
		status: "pending",
		needsVerification: true,
	},
};

const verifiedOrder: ExchangeOrderPolicyState = {
	id: 42,
	status: "awaiting_payment",
	assetFrom: "RUB",
	amountFrom: 100000,
	rate: 0.4,
	amountToThb: 40000,
	paymentMethod: "card_transfer",
	payoutMethod: "office_cash",
	requisitesIssued: true,
	paymentProofReceived: false,
	paymentVerified: false,
	payoutReady: false,
	payoutCompleted: false,
	payoutCodeIssued: false,
	verificationId: "ver_1",
};

const verifiedState: ExchangePolicyState = {
	stageSlug: "payment",
	verification: {
		verified: true,
		status: "verified",
		needsVerification: false,
		verificationId: "ver_1",
	},
	order: verifiedOrder,
};

const paymentReviewState: ExchangePolicyState = {
	...verifiedState,
	stageSlug: "payment_proof_waiting",
	order: {
		...verifiedOrder,
		id: 43,
		paymentProofReceived: true,
	},
};

const paidState: ExchangePolicyState = {
	...verifiedState,
	stageSlug: "payout",
	order: {
		...verifiedOrder,
		id: 44,
		status: "paid",
		network: "TRC20",
		paymentMethod: "crypto_transfer",
		payoutLocation: "Patong office",
		paymentProofReceived: true,
		paymentVerified: true,
	},
};

const rejectedKycState: ExchangePolicyState = {
	stageSlug: "verification_check",
	verification: {
		verified: false,
		status: "rejected",
		needsVerification: true,
	},
	order: {
		...verifiedOrder,
		id: 45,
		requisitesIssued: false,
	},
};

const waitingForRequisitesState: ExchangePolicyState = {
	...verifiedState,
	stageSlug: "order_created",
	order: {
		...verifiedOrder,
		id: 46,
		requisitesIssued: false,
	},
};

describe("buildExchangeAnswerQualityContext", () => {
	it("selects every stage-specific response contract with contract metadata", () => {
		const cases: Array<{
			id: ExchangeResponseContractId;
			userMessageText: string;
			state?: ExchangePolicyState | null;
			history?: Array<{ role: "user" | "assistant"; text: string }>;
			expectedPackIncludes: string[];
		}> = [
			{
				id: "quote",
				userMessageText: "Сколько получу за 500 USDT?",
				expectedPackIncludes: ["allowed_next_actions: compute_exchange_quote"],
			},
			{
				id: "quote_confirmed",
				userMessageText: "Подтверждаю, оформляйте.",
				expectedPackIncludes: ["allowed_next_actions: create_exchange_order"],
			},
			{
				id: "kyc_requested",
				userMessageText: "Куда переводить рубли?",
				state: pendingKycState,
				expectedPackIncludes: ["required_facts: verification status"],
			},
			{
				id: "kyc_submitted",
				userMessageText: "Вот видео и паспорт.",
				state: pendingKycState,
				expectedPackIncludes: [
					"handoff_behavior: создать operator handoff `kyc_review`",
				],
			},
			{
				id: "payment_requisites",
				userMessageText: "Что по заявке?",
				state: verifiedState,
				expectedPackIncludes: ["cta: Попросить оплатить"],
			},
			{
				id: "payment_review",
				userMessageText: "Статус оплаты?",
				state: paymentReviewState,
				expectedPackIncludes: ["paymentVerified=false"],
			},
			{
				id: "office_pickup",
				userMessageText: "Можно забрать в офисе?",
				state: verifiedState,
				expectedPackIncludes: ["required_facts: paymentVerified"],
			},
			{
				id: "payout",
				userMessageText: "Когда выдача?",
				state: paidState,
				expectedPackIncludes: ["allowed_next_actions: operator_handoff_payout"],
			},
			{
				id: "operator_handoff",
				userMessageText: "Нужен оператор, хочу индивидуальные условия.",
				expectedPackIncludes: ["handoff_behavior: создать operator handoff"],
			},
			{
				id: "cancelled",
				userMessageText: "Отмените, я передумал.",
				expectedPackIncludes: ["cta: Предложить написать сумму/валюту заново"],
			},
			{
				id: "general",
				userMessageText: "Какой сейчас этап?",
				expectedPackIncludes: ["required_facts: current stage"],
			},
		];

		for (const item of cases) {
			const context = buildExchangeAnswerQualityContext({
				state: item.state,
				history: item.history,
				userMessageText: item.userMessageText,
			});

			expect(context.contract.id).toBe(item.id);
			expect(context.contract.tone.length).toBeGreaterThan(0);
			expect(context.contract.requiredFacts.length).toBeGreaterThan(0);
			expect(context.contract.cta.length).toBeGreaterThan(0);
			expect(context.contract.handoffBehavior.length).toBeGreaterThan(0);
			expect(context.statePack).toContain(`response_contract: ${item.id}`);
			expect(context.statePack).toContain("tone:");
			expect(context.statePack).toContain("required_facts:");
			expect(context.statePack).toContain("cta:");
			expect(context.statePack).toContain("handoff_behavior:");
			for (const needle of item.expectedPackIncludes) {
				expect(context.statePack).toContain(needle);
			}
		}
	});

	it("returns deterministic replies and handoff metadata for sensitive exchange moments", () => {
		const cases = [
			{
				title: "KYC media/document submission",
				text: "Вот фото паспорта и видео.",
				state: pendingKycState,
				contractId: "kyc_submitted",
				replyIncludes: [
					"Принял документ/видео",
					"Я не провожу KYC автоматически",
				],
				replyExcludes: [/KYC\s+подтвержд[её]н/iu],
				handoffReason: "kyc_review",
			},
			{
				title: "KYC rejected",
				text: "Что дальше?",
				state: rejectedKycState,
				contractId: "kyc_requested",
				replyIncludes: [
					"KYC сейчас в статусе повторной проверки",
					"не могу выдать реквизиты",
				],
				replyExcludes: [/KYC\s+подтвержд[её]н|оплатите|переведите/iu],
				handoffReason: "kyc_review",
			},
			{
				title: "requisites withheld until system state allows them",
				text: "Куда переводить рубли? Дайте карту.",
				state: waitingForRequisitesState,
				contractId: "payment_requisites",
				replyIncludes: [
					"Реквизиты пока не выданы системой",
					"не буду придумывать карту",
				],
				replyExcludes: [/карта\s+\d{4}|https?:\/\/|T[A-Za-z0-9]{20,}/u],
				handoffReason: null,
			},
			{
				title: "persisted payment proof waits for review",
				text: "Что по оплате?",
				state: paymentReviewState,
				contractId: "payment_review",
				replyIncludes: [
					"Чек/скрин уже принят",
					"не подтверждаю оплату автоматически",
				],
				replyExcludes: [/оплата\s+(?:получена|подтверждена|зачислена)/iu],
				handoffReason: "payment_review",
			},
			{
				title: "verified payment moves to payout handoff",
				text: "Что дальше?",
				state: paidState,
				contractId: "payout",
				replyIncludes: [
					"Оплата отмечена как проверенная",
					"Передаю заявку оператору",
				],
				replyExcludes: [/код\s+\d{3,}|выдача\s+завершена/iu],
				handoffReason: "payout_review",
			},
		] as const;

		for (const item of cases) {
			const context = buildExchangeAnswerQualityContext({
				state: item.state,
				userMessageText: item.text,
			});
			expect(context.contract.id).toBe(item.contractId);
			expect(context.deterministicReply).toBeString();
			for (const needle of item.replyIncludes) {
				expect(context.deterministicReply).toContain(needle);
			}
			for (const pattern of item.replyExcludes) {
				expect(context.deterministicReply ?? "").not.toMatch(pattern);
			}
			const handoff = exchangeOperatorHandoffForContext(context);
			if (item.handoffReason) {
				expect(handoff).toMatchObject({
					reason: item.handoffReason,
					contractId: item.contractId,
				});
				expect(handoff?.action.length).toBeGreaterThan(20);
				expect(handoff?.accepted?.length ?? 0).toBeGreaterThan(20);
				expect(handoff?.pending?.length ?? 0).toBeGreaterThan(20);
				expect(handoff?.reviewPath).toBeString();
				expect(handoff?.context?.length ?? 0).toBeGreaterThan(20);
				expect(handoff?.urgency?.length ?? 0).toBeGreaterThan(10);
			} else {
				expect(handoff).toBeNull();
			}
		}
	});

	it("builds concrete operator handoff copy with safe exchange context", () => {
		const kycContext = buildExchangeAnswerQualityContext({
			state: {
				...pendingKycState,
				order: {
					...verifiedOrder,
					id: 47,
					network: "TRC20",
					paymentMethod: "crypto_transfer",
					requisitesIssued: false,
					paymentProofReceived: false,
				},
			},
			userMessageText: "Вот фото паспорта и видео.",
		});
		const kyc = exchangeOperatorHandoffForContext(kycContext);
		expect(kyc).toMatchObject({
			reason: "kyc_review",
			title: "KYC: проверить документ/видео",
			reviewPath: "operator_or_external_kyc",
			orderId: 47,
			stageSlug: "verification_check",
			amount: "100000 RUB -> 40000 THB",
			rail: "crypto transfer",
			network: "TRC20",
			priority: "high",
		});
		expect(kyc?.accepted).toContain("KYC-материалы");
		expect(kyc?.pending).toContain("реквизиты");
		expect(kyc?.action).toContain("внешний KYC-сервис");
		expect(kyc?.action).toContain("manual operator review");
		expect(kyc?.context).toContain("media=document/video");
		expect(kyc?.context).not.toContain("passport.jpg");

		const paymentContext = buildExchangeAnswerQualityContext({
			state: paymentReviewState,
			userMessageText: "Вот чек, перевод ушёл.",
		});
		const payment = exchangeOperatorHandoffForContext(paymentContext);
		expect(payment).toMatchObject({
			reason: "payment_review",
			title: "Оплата: проверить чек/скрин",
			reviewPath: "operator_or_payment_service",
			orderId: 43,
			stageSlug: "payment_proof_waiting",
			amount: "100000 RUB -> 40000 THB",
			rail: "card transfer",
			priority: "high",
		});
		expect(payment?.accepted).toContain("Чек/скрин оплаты");
		expect(payment?.pending).toContain("paymentVerified=true");
		expect(payment?.action).toContain("платёжный сервис");
		expect(payment?.action).toContain("manual payment review");
		expect(payment?.context).toContain("proof media=receipt/screenshot");
		expect(payment?.context).not.toMatch(/карта\s+\d{4}|T[A-Za-z0-9]{20,}/u);
	});

	it("builds redacted debug payload and trace lines for diagnostics", () => {
		expect(
			redactExchangeDebugText(
				"pay https://secret.test card 2200 7000 1234 5678 wallet TQ1abcdEFGHijkLMNOPqrstuvXYZ12345 passport.jpg",
			),
		).toBe(
			"pay [redacted_url] card [redacted_number] wallet [redacted_crypto_address] [redacted_file]",
		);

		const context = buildExchangeAnswerQualityContext({
			state: {
				stageSlug: "payout",
				verification: {
					verified: true,
					status: "verified",
					needsVerification: false,
					verificationId: "ver_1",
				},
				order: {
					...verifiedOrder,
					id: 48,
					status: "paid",
					paymentMethod: null,
					paymentRail: "card 2200 7000 1234 5678",
					payoutLocation:
						"https://secret.test office passport.jpg TQ1abcdEFGHijkLMNOPqrstuvXYZ12345",
					paymentProofReceived: true,
					paymentVerified: true,
				},
			},
			userMessageText: "Что дальше?",
		});
		const debug = buildExchangeAnswerQualityDebugPayload({
			context,
			path: "replay",
		});
		expect(debug.contractId).toBe("payout");
		expect(debug.stateSummary.knownFields.join(" ")).toContain(
			"[redacted_number]",
		);
		expect(debug.handoff.context).toContain("[redacted_url]");
		expect(debug.handoff.context).toContain("[redacted_crypto_address]");
		expect(debug.handoff.context).toContain("[redacted_file]");
		const trace = formatExchangeAnswerQualityDebugTrace(debug).join("\n");
		expect(trace).toContain("debug_contract=payout");
		expect(trace).toContain("debug_state");
		expect(trace).toContain("debug_handoff");
		expect(trace).not.toContain("https://secret.test");
		expect(trace).not.toContain("2200 7000 1234 5678");
		expect(trace).not.toContain("TQ1abcdEFGHijkLMNOPqrstuvXYZ12345");
		expect(trace).not.toContain("passport.jpg");

		const guard = guardExchangePolicy({
			text: "Оплата получена и подтверждена, готовлю выдачу.",
			state: paymentReviewState,
		});
		const guardDebug = buildExchangeAnswerQualityDebugPayload({
			context,
			path: "replay",
			guard,
			event: "guard",
		});
		expect(guardDebug.guard).toMatchObject({
			ok: false,
			reason: "payment_auto_verified",
			fallbackPath: "payment_review_fallback",
		});
		expect(
			formatExchangeAnswerQualityDebugTrace(guardDebug).join("\n"),
		).toContain(
			"debug_guard ok=no reason=payment_auto_verified fallbackPath=payment_review_fallback",
		);
	});
});
