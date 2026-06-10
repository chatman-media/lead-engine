import {
	buildExchangeAnswerQualityContext,
	buildExchangeAnswerQualityDebugPayload,
	type ExchangePolicyState,
	type ExchangeResponseContractId,
	formatExchangeAnswerQualityDebugTrace,
	guardExchangePolicy,
} from "@chatman-media/conversation-engine";
import { guardExchangeToolForStage } from "./tools.ts";

export interface ExchangeGoldenCase {
	id: string;
	title: string;
	expectedWorkflow: string[];
	messages: Array<{ from: string; text: string }>;
}

export interface ExchangeGoldenFailure {
	caseId: string;
	expected: string;
	actual: string;
	trace: string[];
}

export interface ExchangeGoldenResult {
	caseId: string;
	passed: boolean;
	failures: ExchangeGoldenFailure[];
	trace: string[];
}

export interface ExchangeAnswerQualityGoldenCase {
	id: string;
	title: string;
	userMessageText: string;
	state?: ExchangePolicyState | null;
	history?: Array<{
		role: "user" | "assistant" | "human" | "system";
		text: string;
	}>;
	expectedContract: ExchangeResponseContractId;
	expectedDeterministic: boolean;
	replyIncludes?: string[];
	replyExcludes?: RegExp[];
	statePackIncludes?: string[];
	traceFlagsInclude?: string[];
}

type ExchangeDialogMessage = {
	role: "user" | "assistant" | "human" | "system";
	text: string;
};

type UnsafeDraftExpectation = {
	label: string;
	text: string;
	expectedReason?: string;
};

export interface ExchangeBadDialogGoldenCase {
	id: string;
	title: string;
	messages: ExchangeDialogMessage[];
	state?: ExchangePolicyState | null;
	expectedContract: ExchangeResponseContractId;
	minContract?: ExchangeResponseContractId;
	expectedDeterministic?: boolean;
	nextStepIncludes: string[];
	statePackIncludes?: string[];
	replyIncludes?: string[];
	replyExcludes?: RegExp[];
	traceFlagsInclude?: string[];
	unsafeDrafts?: UnsafeDraftExpectation[];
}

type WorkflowExpectation = {
	stageSlug: string;
	toolName: string;
	label: string;
};

const WORKFLOW_EXPECTATIONS: Record<string, WorkflowExpectation> = {
	rate_quote: {
		stageSlug: "exchange_request",
		toolName: "compute_exchange_quote",
		label: "rate quote must be computed through quote tool",
	},
	kyc_required: {
		stageSlug: "verification_check",
		toolName: "check_exchange_verification",
		label: "KYC status must be checked at verification stage",
	},
	requisites_qr: {
		stageSlug: "order_created",
		toolName: "fetch_exchange_requisites",
		label: "QR/SBP requisites must be fetched after order creation",
	},
	requisites_card: {
		stageSlug: "order_created",
		toolName: "fetch_exchange_requisites",
		label: "card requisites must be fetched after order creation",
	},
	requisites_crypto_wallet: {
		stageSlug: "order_created",
		toolName: "fetch_exchange_requisites",
		label: "crypto wallet requisites must be fetched after order creation",
	},
	requisites_binance_id: {
		stageSlug: "order_created",
		toolName: "fetch_exchange_requisites",
		label: "Binance ID requisites must be fetched after order creation",
	},
	receipt_request: {
		stageSlug: "payment_proof_waiting",
		toolName: "verify_exchange_payment",
		label: "payment proof must be verified only after requisites were sent",
	},
};

const CONTRACT_SEQUENCE_RANK: Record<ExchangeResponseContractId, number> = {
	general: 0,
	quote: 1,
	quote_confirmed: 2,
	kyc_requested: 3,
	kyc_submitted: 3,
	payment_requisites: 4,
	payment_review: 5,
	office_pickup: 6,
	payout: 7,
	operator_handoff: 8,
	cancelled: 9,
};

const FORBIDDEN_DRAFTS = [
	{
		label: "unbacked quote",
		text: "Курс 31.5, получите 10553 THB.",
		expectedReason: "unbacked_quote",
	},
	{
		label: "unbacked card requisites",
		text: "Оплатите по карте 2200 7000 1234 5678, после оплаты пришлите чек.",
		expectedReason: "unbacked_requisites",
	},
	{
		label: "unbacked payout code",
		text: "Код выдачи 482913, можно снимать в банкомате.",
		expectedReason: "unbacked_payout_code",
	},
	{
		label: "manual rate negotiation",
		text: "Для вас сделаем курс лучше, договоримся.",
		expectedReason: "rate_negotiation",
	},
	{
		label: "auto KYC verification",
		text: "Я проверил видео, KYC подтверждён. Продолжаем.",
		expectedReason: "kyc_auto_verified",
	},
	{
		label: "auto payment confirmation",
		text: "Оплата получена и подтверждена, готовлю выдачу.",
		expectedReason: "payment_auto_verified",
	},
];

export const EXCHANGE_ANSWER_QUALITY_CASES: ExchangeAnswerQualityGoldenCase[] =
	[
		{
			id: "quote-intake-contract",
			title: "Quote request uses quote response contract",
			userMessageText: "Сколько получу за 500 USDT TRC20?",
			expectedContract: "quote",
			expectedDeterministic: false,
			statePackIncludes: [
				"response_contract: quote",
				"required_facts: валюта/актив отправки",
				"cta: Если курс подходит",
				"allowed_next_actions: compute_exchange_quote",
			],
		},
		{
			id: "quote-confirmed-contract",
			title: "Quote acceptance moves to order creation contract",
			userMessageText: "Подтверждаю, оформляйте заявку.",
			expectedContract: "quote_confirmed",
			expectedDeterministic: false,
			statePackIncludes: [
				"response_contract: quote_confirmed",
				"required_facts: подтверждённая quote-сумма",
				"allowed_next_actions: create_exchange_order",
			],
		},
		{
			id: "kyc-video-handoff",
			title: "KYC video is accepted but not auto-verified",
			userMessageText: "Вот видео и паспорт.",
			history: [
				{
					role: "assistant",
					text: "Для обмена нужно пройти верификацию: пришлите документ и короткое видео/кружок с ФИО.",
				},
			],
			state: {
				stageSlug: "verification_check",
				verification: {
					verified: false,
					status: "pending",
					needsVerification: true,
				},
			},
			expectedContract: "kyc_submitted",
			expectedDeterministic: true,
			replyIncludes: ["Принял документ/видео", "Проверку делает"],
			replyExcludes: [/KYC\s+подтвержд[её]н/iu, /я\s+проверил/iu],
			statePackIncludes: [
				"response_contract: kyc_submitted",
				"verification: status=pending",
				"handoff_behavior: создать operator handoff `kyc_review`",
			],
			traceFlagsInclude: ["kyc_pending", "message_kyc_attachment"],
		},
		{
			id: "requisites-blocked-before-kyc",
			title: "Payment requisites are blocked before KYC",
			userMessageText: "Куда переводить рубли? Дайте карту.",
			state: {
				stageSlug: "verification_check",
				verification: {
					verified: false,
					status: "pending",
					needsVerification: true,
				},
			},
			expectedContract: "kyc_requested",
			expectedDeterministic: true,
			replyIncludes: [
				"Сначала нужно пройти верификацию",
				"дадим конкретные реквизиты",
			],
			replyExcludes: [/карта\s+\d{4}|оплатите|переведите/iu],
			statePackIncludes: [
				"response_contract: kyc_requested",
				"required_facts: verification status",
				"forbidden: писать, что KYC уже пройден",
			],
			traceFlagsInclude: ["kyc_pending"],
		},
		{
			id: "kyc-rejected-repeat-review",
			title: "Rejected KYC cannot progress to payment or payout",
			userMessageText: "Что дальше? Можно уже оплатить?",
			state: {
				stageSlug: "verification_check",
				verification: {
					verified: false,
					status: "rejected",
					needsVerification: true,
				},
				order: {
					id: 88,
					status: "created",
					assetFrom: "RUB",
					amountFrom: 100000,
					amountToThb: 40000,
					paymentMethod: "card_transfer",
					payoutMethod: "office_cash",
					requisitesIssued: false,
					paymentProofReceived: false,
					paymentVerified: false,
					payoutReady: false,
					payoutCompleted: false,
					payoutCodeIssued: false,
				},
			},
			expectedContract: "kyc_requested",
			expectedDeterministic: true,
			replyIncludes: [
				"KYC сейчас в статусе повторной проверки",
				"не могу выдать реквизиты",
			],
			replyExcludes: [
				/KYC\s+подтвержд[её]н/iu,
				/оплатите|переведите|карта\s+\d{4}/iu,
			],
			statePackIncludes: [
				"response_contract: kyc_requested",
				"known_fields:",
				"kycVerified=no",
			],
			traceFlagsInclude: ["kyc_pending", "kyc_rejected"],
		},
		{
			id: "payment-proof-review",
			title: "Payment proof is routed to review, not confirmed",
			userMessageText: "Вот чек, оплатил рублями.",
			state: {
				stageSlug: "payment_proof_waiting",
				verification: {
					verified: true,
					status: "verified",
					needsVerification: false,
					verificationId: "ver_1",
				},
				order: {
					id: 101,
					status: "awaiting_payment",
					assetFrom: "RUB",
					amountFrom: 100000,
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
				},
			},
			expectedContract: "payment_review",
			expectedDeterministic: true,
			replyIncludes: [
				"Принял чек/скрин оплаты",
				"не подтверждаю оплату автоматически",
			],
			replyExcludes: [/оплата\s+(?:получена|подтверждена|зачислена)/iu],
			statePackIncludes: ["response_contract: payment_review", "verified=no"],
			traceFlagsInclude: ["requisites_issued", "message_payment_proof"],
		},
		{
			id: "persisted-payment-proof-review",
			title: "Persisted payment proof remains in review until verified",
			userMessageText: "Что по оплате?",
			state: {
				stageSlug: "payment_proof_waiting",
				verification: {
					verified: true,
					status: "verified",
					needsVerification: false,
					verificationId: "ver_1",
				},
				order: {
					id: 103,
					status: "awaiting_payment",
					assetFrom: "RUB",
					amountFrom: 100000,
					amountToThb: 40000,
					paymentMethod: "card_transfer",
					payoutMethod: "office_cash",
					requisitesIssued: true,
					paymentProofReceived: true,
					paymentVerified: false,
					payoutReady: false,
					payoutCompleted: false,
					payoutCodeIssued: false,
					verificationId: "ver_1",
				},
			},
			expectedContract: "payment_review",
			expectedDeterministic: true,
			replyIncludes: [
				"Чек/скрин уже принят",
				"не подтверждаю оплату автоматически",
			],
			replyExcludes: [/оплата\s+(?:получена|подтверждена|зачислена)/iu],
			statePackIncludes: [
				"response_contract: payment_review",
				"paymentProofReceived=yes",
				"paymentVerified=no",
			],
			traceFlagsInclude: ["payment_proof_received"],
		},
		{
			id: "payment-claim-needs-proof",
			title: "Payment claim without receipt asks for proof",
			userMessageText: "Я оплатил рублями.",
			state: {
				stageSlug: "payment_proof_waiting",
				verification: {
					verified: true,
					status: "verified",
					needsVerification: false,
					verificationId: "ver_1",
				},
				order: {
					id: 102,
					status: "awaiting_payment",
					assetFrom: "RUB",
					amountFrom: 100000,
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
				},
			},
			expectedContract: "payment_requisites",
			expectedDeterministic: true,
			replyIncludes: ["без чека или скрина", "Пришлите чек/скрин"],
			replyExcludes: [
				/Принял чек\/скрин оплаты/iu,
				/оплата\s+(?:получена|подтверждена|зачислена)/iu,
			],
			statePackIncludes: [
				"response_contract: payment_requisites",
				"payment: requisitesIssued=yes",
				"cta: Попросить оплатить",
			],
			traceFlagsInclude: ["requisites_issued"],
		},
		{
			id: "withhold-requisites-until-issued",
			title: "Payment details are withheld until system has issued requisites",
			userMessageText: "Куда переводить рубли? Дайте карту.",
			state: {
				stageSlug: "order_created",
				verification: {
					verified: true,
					status: "verified",
					needsVerification: false,
					verificationId: "ver_1",
				},
				order: {
					id: 104,
					status: "created",
					assetFrom: "RUB",
					amountFrom: 100000,
					amountToThb: 40000,
					paymentMethod: "card_transfer",
					payoutMethod: "office_cash",
					requisitesIssued: false,
					paymentProofReceived: false,
					paymentVerified: false,
					payoutReady: false,
					payoutCompleted: false,
					payoutCodeIssued: false,
					verificationId: "ver_1",
				},
			},
			expectedContract: "payment_requisites",
			expectedDeterministic: true,
			replyIncludes: [
				"Реквизиты пока не выданы системой",
				"не буду придумывать карту",
			],
			replyExcludes: [/карта\s+\d{4}|https?:\/\/|T[A-Za-z0-9]{20,}/u],
			statePackIncludes: [
				"response_contract: payment_requisites",
				"requisitesIssued=no",
			],
			traceFlagsInclude: ["kyc_verified"],
		},
		{
			id: "office-pickup-waits-for-kyc",
			title: "Office pickup request cannot skip pending KYC",
			userMessageText: "Получить в офисе можно?",
			state: {
				stageSlug: "verification_check",
				verification: {
					verified: false,
					status: "pending",
					needsVerification: true,
				},
			},
			expectedContract: "kyc_requested",
			expectedDeterministic: true,
			replyIncludes: ["Сначала нужно пройти верификацию", "После проверки"],
			replyExcludes: [/оплатите|переведите|карта\s+\d{4}/iu],
			statePackIncludes: ["response_contract: kyc_requested"],
			traceFlagsInclude: ["kyc_pending", "message_office_pickup"],
		},
		{
			id: "paid-office-pickup-handoff",
			title: "Verified payment can move to office payout handoff",
			userMessageText: "Можно забрать в офисе?",
			state: {
				stageSlug: "payout",
				verification: {
					verified: true,
					status: "verified",
					needsVerification: false,
					verificationId: "ver_2",
				},
				order: {
					id: 202,
					status: "paid",
					assetFrom: "USDT",
					network: "TRC20",
					amountFrom: 500,
					amountToThb: 15750,
					paymentMethod: "crypto_transfer",
					payoutMethod: "office_cash",
					payoutLocation: "Patong office",
					requisitesIssued: true,
					paymentProofReceived: true,
					paymentVerified: true,
					payoutReady: false,
					payoutCompleted: false,
					payoutCodeIssued: false,
					verificationId: "ver_2",
				},
			},
			expectedContract: "office_pickup",
			expectedDeterministic: true,
			replyIncludes: ["Оплата отмечена как проверенная", "Patong office"],
			replyExcludes: [/выдача\s+завершена|деньги\s+выданы/iu],
			statePackIncludes: [
				"response_contract: office_pickup",
				"payment: requisitesIssued=yes",
				"required_facts: paymentVerified",
			],
			traceFlagsInclude: ["payment_verified", "message_office_pickup"],
		},
		{
			id: "payout-handoff-contract",
			title: "Payout question after verified payment uses payout contract",
			userMessageText: "Когда будет выдача?",
			state: {
				stageSlug: "payout",
				verification: {
					verified: true,
					status: "verified",
					needsVerification: false,
					verificationId: "ver_3",
				},
				order: {
					id: 203,
					status: "paid",
					assetFrom: "USDT",
					network: "TRC20",
					amountFrom: 700,
					amountToThb: 22050,
					paymentMethod: "crypto_transfer",
					payoutMethod: "thai_bank_transfer",
					requisitesIssued: true,
					paymentProofReceived: true,
					paymentVerified: true,
					payoutReady: false,
					payoutCompleted: false,
					payoutCodeIssued: false,
					verificationId: "ver_3",
				},
			},
			expectedContract: "payout",
			expectedDeterministic: true,
			replyIncludes: [
				"Оплата отмечена как проверенная",
				"Передаю заявку оператору",
			],
			replyExcludes: [/выдача\s+завершена|код\s+\d{3,}/iu],
			statePackIncludes: [
				"response_contract: payout",
				"allowed_next_actions: operator_handoff_payout",
				"handoff_behavior: создать payout handoff",
			],
			traceFlagsInclude: ["payment_verified"],
		},
		{
			id: "verified-payment-generic-next-step",
			title:
				"Verified payment gets deterministic payout handoff even on generic status question",
			userMessageText: "Что дальше?",
			state: {
				stageSlug: "payment_verified",
				verification: {
					verified: true,
					status: "verified",
					needsVerification: false,
					verificationId: "ver_4",
				},
				order: {
					id: 204,
					status: "paid",
					assetFrom: "USDT",
					network: "TRC20",
					amountFrom: 700,
					amountToThb: 22050,
					paymentMethod: "crypto_transfer",
					payoutMethod: "thai_bank_transfer",
					requisitesIssued: true,
					paymentProofReceived: true,
					paymentVerified: true,
					payoutReady: false,
					payoutCompleted: false,
					payoutCodeIssued: false,
					verificationId: "ver_4",
				},
			},
			expectedContract: "payout",
			expectedDeterministic: true,
			replyIncludes: [
				"Оплата отмечена как проверенная",
				"Передаю заявку оператору",
			],
			replyExcludes: [/код\s+\d{3,}|выдача\s+завершена/iu],
			statePackIncludes: [
				"response_contract: payout",
				"allowed_next_actions: operator_handoff_payout",
			],
			traceFlagsInclude: ["payment_verified"],
		},
		{
			id: "operator-handoff-contract",
			title: "Manual condition request uses operator handoff contract",
			userMessageText: "Нужен оператор, хочу индивидуальные условия.",
			expectedContract: "operator_handoff",
			expectedDeterministic: true,
			replyIncludes: ["Передаю вопрос оператору"],
			replyExcludes: [/одобрено|подтверждаю\s+условия/iu],
			statePackIncludes: [
				"response_contract: operator_handoff",
				"handoff_behavior: создать operator handoff",
			],
			traceFlagsInclude: ["message_operator_request"],
		},
		{
			id: "cancelled-contract",
			title: "Client cancellation uses cancelled contract",
			userMessageText: "Отмените, я передумал.",
			expectedContract: "cancelled",
			expectedDeterministic: true,
			replyIncludes: ["обмен не оформляю"],
			replyExcludes: [/пройти\s+верификацию|оплатите/iu],
			statePackIncludes: [
				"response_contract: cancelled",
				"cta: Предложить написать сумму/валюту заново",
			],
		},
		{
			id: "general-contract",
			title: "Generic status question uses general support contract",
			userMessageText: "Какой сейчас этап?",
			expectedContract: "general",
			expectedDeterministic: false,
			statePackIncludes: [
				"response_contract: general",
				"required_facts: current stage",
				"allowed_next_actions: answer_from_state",
			],
		},
	];

function exchangeOrderFixture(
	overrides: Partial<NonNullable<ExchangePolicyState["order"]>>,
): NonNullable<ExchangePolicyState["order"]> {
	return {
		id: 100,
		status: "created",
		assetFrom: "USDT",
		network: "TRC20",
		amountFrom: 500,
		rate: 31.5,
		amountToThb: 15750,
		paymentMethod: "crypto_transfer",
		payoutMethod: "thai_bank_transfer",
		requisitesIssued: false,
		paymentProofReceived: false,
		paymentVerified: false,
		payoutReady: false,
		payoutCompleted: false,
		payoutCodeIssued: false,
		...overrides,
	};
}

function kycPendingState(
	stageSlug = "verification_check",
): ExchangePolicyState {
	return {
		stageSlug,
		verification: {
			verified: false,
			status: "pending",
			needsVerification: true,
		},
	};
}

function paymentWaitingState(
	overrides: Partial<NonNullable<ExchangePolicyState["order"]>> = {},
): ExchangePolicyState {
	return {
		stageSlug: "payment_proof_waiting",
		verification: {
			verified: true,
			status: "verified",
			needsVerification: false,
			verificationId: "ver_replay",
		},
		order: exchangeOrderFixture({
			id: 201,
			status: "awaiting_payment",
			assetFrom: "RUB",
			network: null,
			amountFrom: 100000,
			rate: 0.39,
			amountToThb: 39000,
			paymentMethod: "card_transfer",
			payoutMethod: "office_cash",
			requisitesIssued: true,
			verificationId: "ver_replay",
			...overrides,
		}),
	};
}

export const EXCHANGE_BAD_DIALOG_REPLAY_CASES: ExchangeBadDialogGoldenCase[] = [
	{
		id: "bad-dialog-quote-accepted-no-repeat",
		title: "Quote accepted then bot must not repeat quote card",
		messages: [
			{ role: "user", text: "Сколько получу за 500 USDT TRC20?" },
			{
				role: "assistant",
				text: "Курс 31.5, получите 15750 THB. Если подходит, подтвердите заявку.",
			},
			{ role: "user", text: "Подходит, оформляйте заявку." },
		],
		expectedContract: "quote_confirmed",
		minContract: "quote_confirmed",
		expectedDeterministic: false,
		nextStepIncludes: ["KYC", "реквизитов"],
		statePackIncludes: [
			"forbidden: повторять карточку курса вместо следующего шага",
			"allowed_next_actions: create_exchange_order",
		],
		unsafeDrafts: [
			{
				label: "repeated quote card",
				text: "Курс 31.5, получите 15750 THB.",
				expectedReason: "unbacked_quote",
			},
		],
	},
	{
		id: "bad-dialog-kyc-media-submitted",
		title: "KYC video/photo submitted must wait for verification",
		messages: [
			{
				role: "assistant",
				text: "Для обмена нужно пройти KYC: пришлите документ и короткое видео.",
			},
			{ role: "user", text: "Вот видео, фото паспорта и селфи." },
		],
		state: kycPendingState(),
		expectedContract: "kyc_submitted",
		minContract: "kyc_submitted",
		expectedDeterministic: true,
		nextStepIncludes: ["Ожидание результата KYC"],
		replyIncludes: ["Принял документ/видео", "Проверку делает"],
		replyExcludes: [/KYC\s+подтвержд[её]н/iu],
		statePackIncludes: [
			"handoff_behavior: создать operator handoff `kyc_review`",
		],
		traceFlagsInclude: ["message_kyc_attachment", "kyc_pending"],
		unsafeDrafts: [
			{
				label: "auto KYC verified",
				text: "KYC подтверждён, можете оплачивать.",
				expectedReason: "kyc_auto_verified",
			},
		],
	},
	{
		id: "bad-dialog-why-kyc-needed",
		title: "KYC objection explains requirement without payment jump",
		messages: [
			{
				role: "assistant",
				text: "Перед оплатой нужно пройти верификацию: документ и короткое видео.",
			},
			{ role: "user", text: "Почему нужен KYC? Можно без него?" },
		],
		state: kycPendingState(),
		expectedContract: "kyc_requested",
		minContract: "kyc_requested",
		expectedDeterministic: true,
		nextStepIncludes: ["Клиент отправляет документ"],
		replyIncludes: ["верификация обязательна", "После проверки"],
		replyExcludes: [/оплатите|переведите|карта\s+\d{4}/iu],
		statePackIncludes: ["forbidden: писать, что KYC уже пройден"],
		traceFlagsInclude: ["kyc_pending"],
		unsafeDrafts: [
			{
				label: "payment before KYC",
				text: "Можно без KYC, оплатите по карте 2200 7000 1234 5678.",
				expectedReason: "unbacked_requisites",
			},
		],
	},
	{
		id: "bad-dialog-rub-payment-office-pickup",
		title: "Ruble payment plus office pickup stays in payment review",
		messages: [
			{
				role: "assistant",
				text: "Реквизиты выданы. После оплаты пришлите чек, затем согласуем выдачу.",
			},
			{
				role: "user",
				text: "Оплатил рублями, вот чек. Хочу забрать наличные в офисе.",
			},
		],
		state: paymentWaitingState(),
		expectedContract: "payment_review",
		minContract: "payment_review",
		expectedDeterministic: true,
		nextStepIncludes: ["Ожидание проверки оплаты"],
		replyIncludes: [
			"Принял чек/скрин оплаты",
			"не подтверждаю оплату автоматически",
		],
		replyExcludes: [/можно\s+забирать|выдача\s+завершена/iu],
		traceFlagsInclude: ["message_payment_proof", "message_office_pickup"],
		unsafeDrafts: [
			{
				label: "auto payment confirmed",
				text: "Оплата подтверждена, можно забирать наличные в офисе.",
				expectedReason: "payment_auto_verified",
			},
		],
	},
	{
		id: "bad-dialog-rate-objection",
		title: "Commission/rate objection requires operator instead of negotiation",
		messages: [
			{
				role: "assistant",
				text: "По расчёту получите 15750 THB. Если курс подходит, подтвердите заявку.",
			},
			{
				role: "user",
				text: "Комиссия большая, можно лучше курс или индивидуальные условия?",
			},
		],
		expectedContract: "operator_handoff",
		minContract: "operator_handoff",
		expectedDeterministic: true,
		nextStepIncludes: ["Оператор принимает решение"],
		replyIncludes: ["Передаю вопрос оператору"],
		statePackIncludes: ["forbidden: обещать ручное одобрение заранее"],
		traceFlagsInclude: ["message_operator_request"],
		unsafeDrafts: [
			{
				label: "manual rate negotiation",
				text: "Для вас сделаем курс лучше, договоримся.",
				expectedReason: "rate_negotiation",
			},
		],
	},
	{
		id: "bad-dialog-payment-proof-submitted",
		title: "Payment proof submission is reviewed, not confirmed",
		messages: [
			{
				role: "assistant",
				text: "Оплатите по выданным реквизитам и пришлите чек.",
			},
			{ role: "user", text: "Вот чек, перевод ушёл." },
		],
		state: paymentWaitingState({ id: 202, payoutMethod: "thai_bank_transfer" }),
		expectedContract: "payment_review",
		minContract: "payment_review",
		expectedDeterministic: true,
		nextStepIncludes: ["Ожидание проверки оплаты"],
		replyIncludes: [
			"Принял чек/скрин оплаты",
			"не подтверждаю оплату автоматически",
		],
		replyExcludes: [/оплата\s+(?:получена|подтверждена|зачислена)/iu],
		traceFlagsInclude: ["message_payment_proof"],
		unsafeDrafts: [
			{
				label: "payment auto verified",
				text: "Оплата получена и подтверждена, готовлю выдачу.",
				expectedReason: "payment_auto_verified",
			},
		],
	},
	{
		id: "bad-dialog-operator-required",
		title: "Explicit operator request creates handoff contract",
		messages: [
			{
				role: "user",
				text: "Мне нужен оператор, вопрос по лимиту и условиям.",
			},
		],
		expectedContract: "operator_handoff",
		minContract: "operator_handoff",
		expectedDeterministic: true,
		nextStepIncludes: ["Оператор принимает решение"],
		replyIncludes: ["Передаю вопрос оператору"],
		statePackIncludes: ["handoff_behavior: создать operator handoff"],
		traceFlagsInclude: ["message_operator_request"],
		unsafeDrafts: [
			{
				label: "rate promise instead of handoff",
				text: "Сделаем курс лучше и согласуем лимит без оператора.",
				expectedReason: "rate_negotiation",
			},
		],
	},
	{
		id: "bad-dialog-cancel-refuse-kyc",
		title: "Client refuses KYC and cancels without pressure",
		messages: [
			{
				role: "assistant",
				text: "Для обмена нужно пройти KYC: пришлите документ и видео.",
			},
			{ role: "user", text: "Не хочу проходить KYC, отмените заявку." },
		],
		state: kycPendingState(),
		expectedContract: "cancelled",
		minContract: "cancelled",
		expectedDeterministic: true,
		nextStepIncludes: ["Диалог закрыт"],
		replyIncludes: ["обмен не оформляю"],
		replyExcludes: [/пройти\s+верификацию|оплатите|переведите/iu],
		statePackIncludes: ["forbidden: давить на прохождение KYC"],
	},
];

export function parseExchangeGoldenJsonl(raw: string): ExchangeGoldenCase[] {
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ExchangeGoldenCase);
}

export function evaluateExchangeGoldenCase(
	item: ExchangeGoldenCase,
): ExchangeGoldenResult {
	const trace: string[] = [];
	const failures: ExchangeGoldenFailure[] = [];

	for (const token of item.expectedWorkflow) {
		const expectation = WORKFLOW_EXPECTATIONS[token];
		if (!expectation) continue;
		const denied = guardExchangeToolForStage(
			expectation.toolName,
			expectation.stageSlug,
		);
		trace.push(`${token}: ${expectation.stageSlug} -> ${expectation.toolName}`);
		if (denied) {
			failures.push({
				caseId: item.id,
				expected: expectation.label,
				actual: `${expectation.toolName} denied at ${expectation.stageSlug}: ${denied.reason}`,
				trace: [...trace],
			});
		}
	}

	for (const draft of FORBIDDEN_DRAFTS) {
		const guarded = guardExchangePolicy({ text: draft.text });
		trace.push(`${draft.label}: ${guarded.ok ? "allowed" : guarded.reason}`);
		if (guarded.ok || guarded.reason !== draft.expectedReason) {
			failures.push({
				caseId: item.id,
				expected: `draft blocked with ${draft.expectedReason}`,
				actual: guarded.ok
					? "draft was allowed"
					: `blocked with ${guarded.reason ?? "unknown"}`,
				trace: [...trace],
			});
		}
	}

	return {
		caseId: item.id,
		passed: failures.length === 0,
		failures,
		trace,
	};
}

export function evaluateExchangeGoldenCases(
	items: ExchangeGoldenCase[],
): ExchangeGoldenResult[] {
	return items.map(evaluateExchangeGoldenCase);
}

export function evaluateExchangeAnswerQualityCase(
	item: ExchangeAnswerQualityGoldenCase,
): ExchangeGoldenResult {
	const failures: ExchangeGoldenFailure[] = [];
	const trace: string[] = [];
	const context = buildExchangeAnswerQualityContext({
		state: item.state,
		history: item.history,
		userMessageText: item.userMessageText,
	});
	trace.push(
		`contract=${context.contract.id} deterministic=${context.deterministicReply ? "yes" : "no"} flags=${context.trace.flags.join(",") || "-"}`,
	);
	trace.push(
		...formatExchangeAnswerQualityDebugTrace(
			buildExchangeAnswerQualityDebugPayload({
				context,
				path: "replay",
			}),
		),
	);

	if (context.contract.id !== item.expectedContract) {
		failures.push({
			caseId: item.id,
			expected: `contract=${item.expectedContract}`,
			actual: `contract=${context.contract.id}`,
			trace: [...trace],
		});
	}

	if (Boolean(context.deterministicReply) !== item.expectedDeterministic) {
		failures.push({
			caseId: item.id,
			expected: `deterministic=${item.expectedDeterministic ? "yes" : "no"}`,
			actual: `deterministic=${context.deterministicReply ? "yes" : "no"}`,
			trace: [...trace],
		});
	}

	const reply = context.deterministicReply ?? "";
	for (const needle of item.replyIncludes ?? []) {
		if (!reply.includes(needle)) {
			failures.push({
				caseId: item.id,
				expected: `reply includes ${needle}`,
				actual: reply || "no deterministic reply",
				trace: [...trace],
			});
		}
	}
	for (const pattern of item.replyExcludes ?? []) {
		if (pattern.test(reply)) {
			failures.push({
				caseId: item.id,
				expected: `reply does not match ${pattern}`,
				actual: reply,
				trace: [...trace],
			});
		}
	}
	for (const needle of item.statePackIncludes ?? []) {
		if (!context.statePack.includes(needle)) {
			failures.push({
				caseId: item.id,
				expected: `statePack includes ${needle}`,
				actual: context.statePack,
				trace: [...trace],
			});
		}
	}
	for (const flag of item.traceFlagsInclude ?? []) {
		if (!context.trace.flags.includes(flag)) {
			failures.push({
				caseId: item.id,
				expected: `trace flag ${flag}`,
				actual: context.trace.flags.join(",") || "no flags",
				trace: [...trace],
			});
		}
	}

	if (context.deterministicReply) {
		const guarded = guardExchangePolicy({
			text: context.deterministicReply,
			state: item.state,
			history: item.history,
		});
		trace.push(`policy_guard=${guarded.ok ? "allowed" : guarded.reason}`);
		trace.push(
			...formatExchangeAnswerQualityDebugTrace(
				buildExchangeAnswerQualityDebugPayload({
					context,
					path: "replay",
					guard: guarded,
					event: "guard",
				}),
			),
		);
		if (!guarded.ok) {
			failures.push({
				caseId: item.id,
				expected: "deterministic reply passes policy guard",
				actual: `blocked with ${guarded.reason ?? "unknown"}`,
				trace: [...trace],
			});
		}
	}

	return {
		caseId: item.id,
		passed: failures.length === 0,
		failures,
		trace,
	};
}

export function evaluateExchangeAnswerQualityCases(
	items: ExchangeAnswerQualityGoldenCase[],
): ExchangeGoldenResult[] {
	return items.map(evaluateExchangeAnswerQualityCase);
}

export function evaluateExchangeBadDialogCase(
	item: ExchangeBadDialogGoldenCase,
): ExchangeGoldenResult {
	const failures: ExchangeGoldenFailure[] = [];
	const trace: string[] = [];
	const lastMessage = item.messages[item.messages.length - 1];
	if (lastMessage?.role !== "user") {
		return {
			caseId: item.id,
			passed: false,
			failures: [
				{
					caseId: item.id,
					expected: "last replay message is from user",
					actual: lastMessage
						? `last role=${lastMessage.role}`
						: "empty dialog",
					trace,
				},
			],
			trace,
		};
	}

	const history = item.messages.slice(0, -1);
	const context = buildExchangeAnswerQualityContext({
		state: item.state,
		history,
		userMessageText: lastMessage.text,
	});
	trace.push(
		`contract=${context.contract.id} deterministic=${context.deterministicReply ? "yes" : "no"} flags=${context.trace.flags.join(",") || "-"}`,
	);
	trace.push(`next_step=${context.contract.nextStep}`);
	trace.push(
		...formatExchangeAnswerQualityDebugTrace(
			buildExchangeAnswerQualityDebugPayload({
				context,
				path: "replay",
			}),
		),
	);

	if (context.contract.id !== item.expectedContract) {
		failures.push({
			caseId: item.id,
			expected: `contract=${item.expectedContract}`,
			actual: `contract=${context.contract.id}`,
			trace: [...trace],
		});
	}

	if (item.minContract) {
		const actualRank = CONTRACT_SEQUENCE_RANK[context.contract.id];
		const minRank = CONTRACT_SEQUENCE_RANK[item.minContract];
		if (actualRank < minRank) {
			failures.push({
				caseId: item.id,
				expected: `no stage rollback before ${item.minContract}`,
				actual: `contract=${context.contract.id}`,
				trace: [...trace],
			});
		}
	}

	if (
		item.expectedDeterministic !== undefined &&
		Boolean(context.deterministicReply) !== item.expectedDeterministic
	) {
		failures.push({
			caseId: item.id,
			expected: `deterministic=${item.expectedDeterministic ? "yes" : "no"}`,
			actual: `deterministic=${context.deterministicReply ? "yes" : "no"}`,
			trace: [...trace],
		});
	}

	const clearNextStepText = [
		context.contract.nextStep,
		context.statePack,
		context.deterministicReply,
	]
		.filter(Boolean)
		.join("\n");
	for (const needle of item.nextStepIncludes) {
		if (!clearNextStepText.includes(needle)) {
			failures.push({
				caseId: item.id,
				expected: `clear next step includes ${needle}`,
				actual: context.contract.nextStep,
				trace: [...trace],
			});
		}
	}

	const reply = context.deterministicReply ?? "";
	for (const needle of item.replyIncludes ?? []) {
		if (!reply.includes(needle)) {
			failures.push({
				caseId: item.id,
				expected: `reply includes ${needle}`,
				actual: reply || "no deterministic reply",
				trace: [...trace],
			});
		}
	}
	for (const pattern of item.replyExcludes ?? []) {
		if (pattern.test(reply)) {
			failures.push({
				caseId: item.id,
				expected: `reply does not match ${pattern}`,
				actual: reply,
				trace: [...trace],
			});
		}
	}
	for (const needle of item.statePackIncludes ?? []) {
		if (!context.statePack.includes(needle)) {
			failures.push({
				caseId: item.id,
				expected: `statePack includes ${needle}`,
				actual: context.statePack,
				trace: [...trace],
			});
		}
	}
	for (const flag of item.traceFlagsInclude ?? []) {
		if (!context.trace.flags.includes(flag)) {
			failures.push({
				caseId: item.id,
				expected: `trace flag ${flag}`,
				actual: context.trace.flags.join(",") || "no flags",
				trace: [...trace],
			});
		}
	}

	if (context.deterministicReply) {
		const guarded = guardExchangePolicy({
			text: context.deterministicReply,
			state: item.state,
			history,
		});
		trace.push(`policy_guard=${guarded.ok ? "allowed" : guarded.reason}`);
		trace.push(
			...formatExchangeAnswerQualityDebugTrace(
				buildExchangeAnswerQualityDebugPayload({
					context,
					path: "replay",
					guard: guarded,
					event: "guard",
				}),
			),
		);
		if (!guarded.ok) {
			failures.push({
				caseId: item.id,
				expected: "deterministic reply passes policy guard",
				actual: `blocked with ${guarded.reason ?? "unknown"}`,
				trace: [...trace],
			});
		}
	}

	for (const draft of item.unsafeDrafts ?? []) {
		const guarded = guardExchangePolicy({
			text: draft.text,
			state: item.state,
			history,
		});
		trace.push(
			`unsafe_draft:${draft.label}=${guarded.ok ? "allowed" : guarded.reason}`,
		);
		if (guarded.ok) {
			failures.push({
				caseId: item.id,
				expected: `unsafe draft "${draft.label}" blocked`,
				actual: "draft was allowed",
				trace: [...trace],
			});
			continue;
		}
		if (draft.expectedReason && guarded.reason !== draft.expectedReason) {
			failures.push({
				caseId: item.id,
				expected: `unsafe draft "${draft.label}" blocked with ${draft.expectedReason}`,
				actual: `blocked with ${guarded.reason ?? "unknown"}`,
				trace: [...trace],
			});
		}
	}

	return {
		caseId: item.id,
		passed: failures.length === 0,
		failures,
		trace,
	};
}

export function evaluateExchangeBadDialogCases(
	items: ExchangeBadDialogGoldenCase[],
): ExchangeGoldenResult[] {
	return items.map(evaluateExchangeBadDialogCase);
}

export function formatExchangeGoldenFailures(
	results: ExchangeGoldenResult[],
): string {
	const failures = results.flatMap((result) => result.failures);
	if (failures.length === 0) return "";
	return failures
		.map((failure) =>
			[
				`case=${failure.caseId}`,
				`expected=${failure.expected}`,
				`actual=${failure.actual}`,
				`trace=${failure.trace.join(" | ")}`,
			].join("\n"),
		)
		.join("\n\n");
}
