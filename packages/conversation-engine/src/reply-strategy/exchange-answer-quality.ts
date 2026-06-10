import type { OperatorHandoffMeta } from "@chatman-media/channel-core";
import type { MessageRow } from "../dal/messages.ts";
import type {
	ExchangePolicyGuardResult,
	ExchangePolicyState,
} from "./exchange-policy-guard.ts";

export type ExchangeResponseContractId =
	| "quote"
	| "quote_confirmed"
	| "kyc_requested"
	| "kyc_submitted"
	| "payment_requisites"
	| "payment_review"
	| "office_pickup"
	| "payout"
	| "operator_handoff"
	| "cancelled"
	| "general";

export interface ExchangeResponseContract {
	id: ExchangeResponseContractId;
	title: string;
	tone: string;
	goal: string;
	requiredFacts: readonly string[];
	allowed: readonly string[];
	forbidden: readonly string[];
	cta: string;
	nextStep: string;
	handoffBehavior: string;
}

export interface ExchangeAnswerQualityInput {
	state?: ExchangePolicyState | null;
	history?: Array<Pick<MessageRow, "role" | "text">>;
	userMessageText: string;
}

export interface ExchangeAnswerQualityContext {
	contract: ExchangeResponseContract;
	statePack: string;
	trace: ExchangeAnswerQualityTrace;
	handoff: ExchangeAnswerQualityHandoffFacts;
	deterministicReply: string | null;
}

export interface ExchangeAnswerQualityHandoffFacts {
	accepted: string | null;
	pending: string | null;
	reviewPath: OperatorHandoffMeta["reviewPath"] | null;
	context: string | null;
	urgency: string | null;
	amount: string | null;
	rail: string | null;
	network: string | null;
}

export interface ExchangeAnswerQualityTrace {
	contractId: ExchangeResponseContractId;
	stageSlug: string | null;
	orderId: number | null;
	orderStatus: string | null;
	verificationStatus: string | null;
	kycPending: boolean;
	paymentVerified: boolean;
	payoutReady: boolean;
	deterministic: boolean;
	flags: string[];
}

export interface ExchangeAnswerQualityDebugPayload {
	event: "context" | "guard";
	path?: "llm" | "rag" | "replay";
	contractId: ExchangeResponseContractId;
	deterministic: boolean;
	stageSlug: string | null;
	orderId: number | null;
	orderStatus: string | null;
	verificationStatus: string | null;
	flags: string[];
	stateSummary: {
		knownFields: string[];
		missingFields: string[];
		allowedNextActions: string[];
		forbiddenClaims: string[];
	};
	handoff: {
		reason: OperatorHandoffMeta["reason"] | null;
		reviewPath: OperatorHandoffMeta["reviewPath"] | null;
		priority: OperatorHandoffMeta["priority"] | null;
		accepted: string | null;
		pending: string | null;
		context: string | null;
	};
	guard: {
		ok: boolean;
		reason: string | null;
		fallbackPath: string | null;
		fallbackText: string | null;
	} | null;
}

const KYC_PENDING_STAGES = new Set([
	"verification_check",
	"kyc_collection",
	"risk_review",
]);

const KYC_REJECTED_STATUSES = new Set([
	"rejected",
	"declined",
	"denied",
	"failed",
]);

const CONTRACTS: Record<ExchangeResponseContractId, ExchangeResponseContract> =
	{
		quote: {
			id: "quote",
			title: "Quote",
			tone: "точный, коммерческий, без давления",
			goal: "Рассчитать курс/сумму только через tool или подтверждённый контекст.",
			requiredFacts: [
				"валюта/актив отправки",
				"сумма или ожидаемая сумма THB",
				"курс и сумма к получению только из tool/context",
			],
			allowed: [
				"назвать пару, курс, сумму к получению и срок фиксации, если они есть в tool/context",
				"попросить подтверждение курса для создания заявки",
			],
			forbidden: [
				"придумывать курс, комиссию, лимиты или сроки",
				"выдавать реквизиты до созданной заявки и KYC",
			],
			cta: "Если курс подходит, попросить клиента подтвердить заявку.",
			nextStep:
				"Если курс подходит — клиент подтверждает, система создаёт заявку.",
			handoffBehavior:
				"handoff не нужен, если quote рассчитан tool; передать оператору только при индивидуальном курсе/лимите.",
		},
		quote_confirmed: {
			id: "quote_confirmed",
			title: "Quote confirmed",
			tone: "операционный, без повторной продажи",
			goal: "Создать или продолжить заявку без повторного пересчёта, если клиент подтвердил quote.",
			requiredFacts: [
				"подтверждённая quote-сумма или контекст последнего расчёта",
				"статус заявки, если она уже создана",
				"текущий KYC/verification state",
			],
			allowed: [
				"подтвердить, что заявка оформляется",
				"попросить KYC, если проверка ещё не пройдена",
			],
			forbidden: [
				"повторять карточку курса вместо следующего шага",
				"обещать реквизиты до KYC",
			],
			cta: "Дать следующий шаг: KYC или ожидание системных реквизитов.",
			nextStep: "KYC или выдача реквизитов по статусу заявки.",
			handoffBehavior:
				"handoff только если создание заявки/tool вернул risk, manual review или нестандартные условия.",
		},
		kyc_requested: {
			id: "kyc_requested",
			title: "KYC requested",
			tone: "спокойный, объясняющий, без давления",
			goal: "Собрать документы и видео, не имитируя проверку.",
			requiredFacts: [
				"verification status/needsVerification",
				"какие документы или видео нужны",
				"что проверку делает оператор или внешний сервис",
			],
			allowed: [
				"объяснить, какие документы/видео нужны",
				"сказать, что проверяет оператор или внешний сервис",
				"после KYC пообещать продолжить workflow",
			],
			forbidden: [
				"писать, что KYC уже пройден",
				"давать реквизиты или инструкции оплаты",
			],
			cta: "Попросить прислать документ и короткое видео/кружок.",
			nextStep:
				"Клиент отправляет документ и видео; оператор/сервис проверяет.",
			handoffBehavior:
				"handoff не создавать до получения материалов; после вложений перейти в kyc_submitted.",
		},
		kyc_submitted: {
			id: "kyc_submitted",
			title: "KYC submitted",
			tone: "короткий, подтверждающий получение",
			goal: "Принять вложения и передать их на проверку человеку/внешнему сервису.",
			requiredFacts: [
				"получены KYC материалы",
				"verification ещё не подтверждён",
				"кто проверяет материалы",
			],
			allowed: [
				"подтвердить получение документа/видео",
				"сообщить, что заявка ждёт проверки",
			],
			forbidden: [
				"самостоятельно подтверждать личность",
				"переходить к оплате до результата проверки",
			],
			cta: "Сообщить, что проверка передана и нужно дождаться результата.",
			nextStep: "Ожидание результата KYC.",
			handoffBehavior:
				"создать operator handoff `kyc_review` с высоким приоритетом.",
		},
		payment_requisites: {
			id: "payment_requisites",
			title: "Payment requisites",
			tone: "инструктивный, аккуратный с секретами",
			goal: "Довести клиента до оплаты только если реквизиты уже выданы системой.",
			requiredFacts: [
				"order id/status",
				"requisitesIssued",
				"payment method/rail",
				"payment proof status",
			],
			allowed: [
				"сослаться на уже выданные реквизиты без повторного раскрытия секретных данных",
				"попросить чек/подтверждение после оплаты",
			],
			forbidden: [
				"создавать новые реквизиты текстом",
				"подтверждать оплату без tool/persisted state",
			],
			cta: "Попросить оплатить по уже выданным реквизитам и отправить чек/скрин.",
			nextStep: "Клиент оплачивает и отправляет подтверждение.",
			handoffBehavior:
				"handoff только если реквизиты не выданы системой, payment rail не выбран или клиент спорит с условиями.",
		},
		payment_review: {
			id: "payment_review",
			title: "Payment review",
			tone: "короткий, операционный",
			goal: "Принять чек и отправить оплату на проверку.",
			requiredFacts: [
				"proof received или клиент отправил чек",
				"paymentVerified=false",
				"order id/status",
			],
			allowed: [
				"сказать, что чек/подтверждение принято",
				"сказать, что проверку делает оператор или платёжный сервис",
			],
			forbidden: [
				"писать, что деньги зачислены или оплата подтверждена",
				"обещать выдачу до проверки оплаты",
			],
			cta: "Сообщить, что оплата передана на проверку.",
			nextStep: "Ожидание проверки оплаты.",
			handoffBehavior:
				"создать operator handoff `payment_review` с высоким приоритетом.",
		},
		office_pickup: {
			id: "office_pickup",
			title: "Office pickup",
			tone: "практичный, без неподтверждённых адресов/ETA",
			goal: "Обработать получение наличных в офисе как способ выдачи, не перепрыгивая KYC/оплату.",
			requiredFacts: [
				"paymentVerified",
				"payout method",
				"payout location только если есть в state",
			],
			allowed: [
				"зафиксировать намерение клиента получить THB в офисе",
				"объяснить, что адрес/время подтверждает оператор после проверок",
			],
			forbidden: [
				"выдавать деньги до verified payment",
				"выдумывать адрес офиса, если его нет в state",
			],
			cta: "Если оплата проверена — передать оператору выдачу; иначе вернуть к KYC/оплате.",
			nextStep: "KYC → оплата → проверка оплаты → подтверждение офиса/выдачи.",
			handoffBehavior:
				"создать office payout handoff только после paymentVerified=true.",
		},
		payout: {
			id: "payout",
			title: "Payout",
			tone: "уверенный, но только по подтверждённому state",
			goal: "Довести до выдачи после verified payment.",
			requiredFacts: [
				"paymentVerified=true или tool verify_exchange_payment",
				"payout method",
				"payoutReady/code/completed status",
			],
			allowed: [
				"сказать, что оплата проверена, только если это есть в state/tool",
				"передать оператору точку выдачи, код или банк",
			],
			forbidden: [
				"писать, что выдача завершена без status=completed/payout code",
				"придумывать код выдачи, адрес или ETA",
			],
			cta: "Передать оператору или payout-сервису следующий шаг выдачи.",
			nextStep:
				"Оператор подтверждает выдачу или внешний payout-сервис исполняет.",
			handoffBehavior:
				"создать payout handoff, если paymentVerified=true и выдача ещё не completed.",
		},
		operator_handoff: {
			id: "operator_handoff",
			title: "Operator handoff",
			tone: "короткий, честный про ручную проверку",
			goal: "Передать человеку нестандартное решение: индивидуальный курс, риск, кастомная выдача.",
			requiredFacts: [
				"что именно требует оператора",
				"текущий order/status, если есть",
				"один недостающий вопрос, если нужен",
			],
			allowed: [
				"коротко описать, что именно передано оператору",
				"задать один недостающий вопрос, если он нужен для решения",
			],
			forbidden: [
				"обещать ручное одобрение заранее",
				"называть неподтверждённые условия",
			],
			cta: "Сказать, что оператор проверит и ответит в этом диалоге.",
			nextStep: "Оператор принимает решение и отвечает в диалоге.",
			handoffBehavior:
				"создать operator handoff `operator_request` с normal priority.",
		},
		cancelled: {
			id: "cancelled",
			title: "Cancelled",
			tone: "нейтральный, без давления",
			goal: "Спокойно закрыть отказ без давления и без повторного KYC.",
			requiredFacts: [
				"клиент отказался или отменил текущий обмен",
				"текущий обмен не продолжается",
				"для нового обмена нужен новый расчёт",
			],
			allowed: [
				"подтвердить, что обмен не продолжается в чате",
				"объяснить, что для нового обмена нужен новый актуальный расчёт",
			],
			forbidden: [
				"давить на прохождение KYC",
				"повторять заявку или реквизиты",
			],
			cta: "Предложить написать сумму/валюту заново, если клиент вернётся.",
			nextStep: "Диалог закрыт до нового запроса клиента.",
			handoffBehavior:
				"handoff не нужен, если нет спора, риска или pending payment.",
		},
		general: {
			id: "general",
			title: "General exchange support",
			tone: "помогающий, уточняющий",
			goal: "Ответить по текущей стадии обмена без выдуманных фактов.",
			requiredFacts: [
				"current stage",
				"verification state",
				"order state или явное отсутствие order",
			],
			allowed: [
				"объяснять workflow обмена",
				"уточнять сумму, валюту, сеть, способ оплаты/выдачи",
			],
			forbidden: [
				"выдумывать курс, реквизиты, адрес, статус проверки",
				"перескакивать через KYC, payment verification или operator handoff",
			],
			cta: "Собрать недостающие поля или передать оператору, если state недостаточен.",
			nextStep: "Собрать недостающие поля или передать оператору.",
			handoffBehavior:
				"handoff только при нестандартном вопросе, missing state или ручном решении.",
		},
	};

const KYC_REQUEST_RE =
	/(?:верификац|kyc|документ|паспорт|видео|кружок)[^.!\n]{0,120}(?:нужн|обязательн|пришл|отправ|требуется|пройти)|(?:нужн|обязательн|пришл|отправ|пройти)[^.!\n]{0,120}(?:верификац|kyc|документ|паспорт|видео|кружок)/iu;
const KYC_VERIFIED_RE =
	/(?:верификац|kyc|документ|паспорт|видео|кружок)[^.!\n]{0,120}(?:подтвержд[её]н|подтверждена|подтверждено|пройд[её]н|пройдена|проверен|проверена|успешн)|(?:я\s+)?проверил(?:а|и)?[^.!\n]{0,120}(?:верификац|kyc|документ|паспорт|видео|кружок)/iu;

function historyHasPendingKyc(
	history: ExchangeAnswerQualityInput["history"],
): boolean {
	if (!history) return false;
	for (const item of [...history].reverse()) {
		if (item.role !== "assistant" && item.role !== "human") continue;
		if (KYC_VERIFIED_RE.test(item.text)) return false;
		if (KYC_REQUEST_RE.test(item.text)) return true;
	}
	return false;
}

function isCancellation(text: string): boolean {
	return /(?:отказываюсь|отмена|отмените|не\s+готов(?:а)?|не\s+буду|передумал|передумала|не\s+нужно|пока\s+не\s+буду)/iu.test(
		text,
	);
}

function isKycSubmission(text: string): boolean {
	return /(?:вот|держи|отправил(?:а)?|прикрепил(?:а)?|загрузил(?:а)?|выслал(?:а)?|скинул(?:а)?|снял(?:а)?)\s+(?:видео|кружок|документ|паспорт|фото|селфи)|(?:видео|кружок|документ|паспорт|фото|селфи)\s+(?:отправил(?:а)?|прикрепил(?:а)?|загрузил(?:а)?|выслал(?:а)?|скинул(?:а)?|снял(?:а)?)/iu.test(
		text,
	);
}

function isPaymentProofSubmission(text: string): boolean {
	return /(?:вот|держи|отправил(?:а)?|прикрепил(?:а)?|загрузил(?:а)?|выслал(?:а)?|скинул(?:а)?|прислал(?:а)?)\s+(?:чек|квитанц|receipt|proof|скрин|подтверждени[ея]\s+оплат)|(?:чек|квитанц|receipt|proof|скрин)\s+(?:отправил(?:а)?|прикрепил(?:а)?|загрузил(?:а)?|выслал(?:а)?|скинул(?:а)?|прислал(?:а)?)|(?:чек|квитанц|receipt|proof|скрин|подтверждени[ея]\s+оплат)[^.!\n]{0,120}(?:оплатил(?:а)?|перев[её]л|перевела|сделал(?:а)?\s+перевод|плат[её]ж\s+уш[её]л)/iu.test(
		text,
	);
}

function claimsPaymentWithoutProof(text: string): boolean {
	if (isPaymentProofSubmission(text)) return false;
	return /(?:оплатил(?:а)?|перев[её]л|перевела|сделал(?:а)?\s+перевод|плат[её]ж\s+уш[её]л|деньги\s+ушли)/iu.test(
		text,
	);
}

function isOfficePickupRequest(text: string): boolean {
	return /(?:офис|в\s+офисе|из\s+офиса|заберу|забрать|самовывоз|наличн(?:ыми)?|cash)/iu.test(
		text,
	);
}

function asksForPaymentOrRequisites(text: string): boolean {
	return /(?:реквизит|куда|перевести|отправлять|оплатить|карта|банк|сч[её]т|qr|сбп|sbp|кошел[её]к|адрес\s+кошелька|получить|выдач|офис|банкомат|atm)/iu.test(
		text,
	);
}

function asksForPayout(text: string): boolean {
	return /(?:выдач|получить|забрать|код|банкомат|atm|офис|наличн(?:ые|ыми)?|когда\s+будут\s+баты|где\s+забрать)/iu.test(
		text,
	);
}

function asksForQuote(text: string): boolean {
	return /(?:курс|сколько|посчитай|рассчитай|получ(?:у|ить|ится|аю)|на\s+руки|THB|бат|USDT|BTC|ETH|RUB|руб|₽)/iu.test(
		text,
	);
}

function asksForOperator(text: string): boolean {
	return /(?:оператор|человек|менеджер|индивидуальн|ручн|особые\s+условия|лучший\s+курс|можно\s+лучше)/iu.test(
		text,
	);
}

function hasPendingKyc(input: ExchangeAnswerQualityInput): boolean {
	const state = input.state;
	const stageSlug = state?.stageSlug;
	if (state?.verification?.verified === true) return false;
	if (state?.verification?.needsVerification === true) return true;
	if (KYC_PENDING_STAGES.has(stageSlug ?? "")) return true;
	if (historyHasPendingKyc(input.history)) return true;
	return false;
}

function hasRejectedKyc(
	state: ExchangePolicyState | null | undefined,
): boolean {
	const status = state?.verification?.status?.trim().toLowerCase();
	if (!status || state?.verification?.verified === true) return false;
	return (
		KYC_REJECTED_STATUSES.has(status) ||
		/(?:reject|declin|denied|fail|отказ|отклон|не\s+прош)/iu.test(status)
	);
}

function hasVerifiedPayment(
	state: ExchangePolicyState | null | undefined,
): boolean {
	return state?.order?.paymentVerified === true;
}

function hasPayoutReady(
	state: ExchangePolicyState | null | undefined,
): boolean {
	const order = state?.order;
	return (
		order?.payoutReady === true ||
		order?.payoutCodeIssued === true ||
		order?.payoutCompleted === true
	);
}

function hasRequisitesIssued(
	state: ExchangePolicyState | null | undefined,
): boolean {
	return state?.order?.requisitesIssued === true;
}

function paymentNeedsReview(
	state: ExchangePolicyState | null | undefined,
): boolean {
	const order = state?.order;
	if (!order) return false;
	return (
		order.paymentProofReceived === true &&
		order.paymentVerified !== true &&
		order.status !== "completed"
	);
}

function formatMaybe(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	return String(value);
}

function methodLabel(value: string | null | undefined): string | null {
	if (!value) return null;
	const labels: Record<string, string> = {
		crypto_transfer: "crypto transfer",
		sbp_qr: "SBP QR",
		card_transfer: "card transfer",
		bank_transfer: "bank transfer",
		cash: "cash",
		office_cash: "office cash",
		cardless_atm: "cardless ATM",
		courier_cash: "courier cash",
		thai_bank_transfer: "Thai bank transfer",
		atm: "ATM",
	};
	return labels[value] ?? value;
}

function orderAmountLabel(
	state: ExchangePolicyState | null | undefined,
): string | null {
	const order = state?.order;
	if (!order) return null;
	const from =
		order.amountFrom != null || order.assetFrom
			? `${formatMaybe(order.amountFrom) ?? "?"} ${order.assetFrom ?? "asset"}`
			: null;
	const to =
		order.amountToThb != null ? `${formatMaybe(order.amountToThb)} THB` : null;
	if (from && to) return `${from} -> ${to}`;
	return from ?? to;
}

function railLabel(
	state: ExchangePolicyState | null | undefined,
): string | null {
	const order = state?.order;
	if (!order) return null;
	return (
		methodLabel(order.paymentMethod) ?? formatMaybe(order.paymentRail) ?? null
	);
}

function payoutLabel(
	state: ExchangePolicyState | null | undefined,
): string | null {
	const order = state?.order;
	if (!order) return null;
	const base = methodLabel(order.payoutMethod);
	if (base && order.payoutLocation) return `${base}; ${order.payoutLocation}`;
	return base ?? formatMaybe(order.payoutLocation);
}

function safeOrderContext(
	state: ExchangePolicyState | null | undefined,
): string {
	const order = state?.order;
	if (!order) return "Активная exchange-заявка не найдена в state.";
	const parts = [
		`Заявка #${order.id}`,
		`status=${order.status}`,
		orderAmountLabel(state) ? `amount=${orderAmountLabel(state)}` : null,
		railLabel(state) ? `payment=${railLabel(state)}` : null,
		order.network ? `network=${order.network}` : null,
		payoutLabel(state) ? `payout=${payoutLabel(state)}` : null,
		`proofReceived=${order.paymentProofReceived ? "yes" : "no"}`,
		`paymentVerified=${order.paymentVerified ? "yes" : "no"}`,
	]
		.filter(Boolean)
		.join("; ");
	return parts;
}

function orderLine(state: ExchangePolicyState | null | undefined): string {
	const order = state?.order;
	if (!order) return "order: none";
	const pair =
		order.amountFrom != null || order.amountToThb != null || order.assetFrom
			? [
					formatMaybe(order.amountFrom) ?? "?",
					order.assetFrom ?? "asset",
					"->",
					formatMaybe(order.amountToThb) ?? "?",
					"THB",
				].join(" ")
			: "amount: unknown";
	const details = [
		`order: #${order.id} status=${order.status}`,
		`pair=${pair}`,
		order.network ? `network=${order.network}` : null,
		order.rate != null ? `rate=${order.rate}` : null,
		methodLabel(order.paymentMethod)
			? `payment=${methodLabel(order.paymentMethod)}`
			: null,
		order.paymentRail ? `paymentRail=${order.paymentRail}` : null,
		methodLabel(order.payoutMethod)
			? `payout=${methodLabel(order.payoutMethod)}`
			: null,
		order.payoutLocation ? `payoutLocation=${order.payoutLocation}` : null,
	]
		.filter(Boolean)
		.join("; ");
	return details;
}

function verificationLine(
	state: ExchangePolicyState | null | undefined,
): string {
	const verification = state?.verification;
	if (!verification) return "verification: unknown";
	return [
		`verification: status=${verification.status}`,
		`verified=${verification.verified ? "yes" : "no"}`,
		`needsVerification=${verification.needsVerification ? "yes" : "no"}`,
		verification.verificationId ? "hasVerificationId=yes" : null,
	]
		.filter(Boolean)
		.join("; ");
}

function addKnownField(fields: string[], key: string, value: unknown): void {
	const formatted = formatMaybe(value);
	if (formatted) fields.push(`${key}=${formatted}`);
}

function knownFieldsFor(
	state: ExchangePolicyState | null | undefined,
): string[] {
	const fields: string[] = [`stage=${state?.stageSlug ?? "unknown"}`];
	const verification = state?.verification;
	if (verification) {
		fields.push(`verificationStatus=${verification.status}`);
		fields.push(`kycVerified=${verification.verified ? "yes" : "no"}`);
		fields.push(
			`kycNeedsVerification=${verification.needsVerification ? "yes" : "no"}`,
		);
		if (verification.verificationId) fields.push("verificationId=present");
	} else {
		fields.push("verification=unknown");
	}

	const order = state?.order;
	if (!order) {
		fields.push("order=none");
		return fields;
	}

	fields.push(`orderId=${order.id}`);
	fields.push(`orderStatus=${order.status}`);
	addKnownField(fields, "assetFrom", order.assetFrom);
	addKnownField(fields, "network", order.network);
	addKnownField(fields, "amountMode", order.amountMode);
	addKnownField(fields, "requestedAmount", order.requestedAmount);
	addKnownField(fields, "amountFrom", order.amountFrom);
	addKnownField(fields, "rate", order.rate);
	addKnownField(fields, "amountToThb", order.amountToThb);
	addKnownField(fields, "paymentMethod", methodLabel(order.paymentMethod));
	addKnownField(fields, "paymentRail", order.paymentRail);
	addKnownField(fields, "payoutMethod", methodLabel(order.payoutMethod));
	addKnownField(fields, "payoutLocation", order.payoutLocation);
	fields.push(`requisitesIssued=${order.requisitesIssued ? "yes" : "no"}`);
	fields.push(
		`paymentProofReceived=${order.paymentProofReceived ? "yes" : "no"}`,
	);
	fields.push(`paymentVerified=${order.paymentVerified ? "yes" : "no"}`);
	fields.push(`payoutReady=${order.payoutReady ? "yes" : "no"}`);
	fields.push(`payoutCodeIssued=${order.payoutCodeIssued ? "yes" : "no"}`);
	fields.push(`payoutCompleted=${order.payoutCompleted ? "yes" : "no"}`);
	if (order.verificationId) fields.push("orderVerificationId=present");
	return fields;
}

function missingFieldsFor(
	input: ExchangeAnswerQualityInput,
	contract: ExchangeResponseContract,
): string[] {
	const state = input.state;
	const order = state?.order;
	const missing = new Set<string>();

	if (!state) missing.add("exchange_state");
	if (!state?.verification) missing.add("verification_state");
	if (hasPendingKyc(input)) missing.add("kyc_verified");

	if (!order) {
		if (contract.id !== "cancelled") missing.add("active_order");
		if (
			contract.id === "quote" ||
			contract.id === "quote_confirmed" ||
			contract.id === "general"
		) {
			missing.add("asset_from");
			missing.add("amount");
			missing.add("payment_method_or_rail");
			missing.add("payout_method");
		}
		return Array.from(missing);
	}

	if (!order.assetFrom) missing.add("asset_from");
	if (
		order.requestedAmount == null &&
		order.amountFrom == null &&
		order.amountToThb == null
	) {
		missing.add("amount");
	}
	if (
		(contract.id === "quote" ||
			contract.id === "quote_confirmed" ||
			contract.id === "payment_requisites" ||
			contract.id === "payment_review" ||
			contract.id === "payout") &&
		order.rate == null
	) {
		missing.add("rate");
	}
	if (!order.paymentMethod && !order.paymentRail) {
		missing.add("payment_method_or_rail");
	}
	if (!order.payoutMethod) missing.add("payout_method");
	if (order.payoutMethod === "office_cash" && !order.payoutLocation) {
		missing.add("payout_location");
	}
	if (contract.id === "payment_requisites" && !order.requisitesIssued) {
		missing.add("requisites_issued");
	}
	if (
		order.requisitesIssued &&
		!order.paymentProofReceived &&
		!order.paymentVerified
	) {
		missing.add("payment_proof");
	}
	if (order.paymentProofReceived && !order.paymentVerified) {
		missing.add("payment_verified");
	}
	if (order.paymentVerified && !hasPayoutReady(state)) {
		missing.add("payout_ready_or_operator_instruction");
	}
	if (contract.id === "payout" && !order.payoutCompleted) {
		missing.add("payout_completion");
	}

	return Array.from(missing);
}

function allowedNextActionsFor(
	input: ExchangeAnswerQualityInput,
	contract: ExchangeResponseContract,
): string[] {
	const state = input.state;
	const order = state?.order;

	switch (contract.id) {
		case "quote":
			return [
				"compute_exchange_quote",
				"collect_missing_quote_fields",
				"ask_quote_confirmation",
			];
		case "quote_confirmed":
			return [
				"create_exchange_order",
				"request_kyc_if_needed",
				"fetch_requisites_only_after_allowed_state",
			];
		case "kyc_requested":
			return [
				"request_kyc_document_and_video",
				"answer_kyc_questions",
				"wait_for_kyc_submission",
			];
		case "kyc_submitted":
			return ["operator_handoff_kyc_review", "wait_for_verified_kyc_state"];
		case "payment_requisites":
			return [
				order?.requisitesIssued
					? "refer_to_existing_requisites"
					: "wait_for_system_requisites",
				"request_payment_proof",
				"do_not_reissue_secrets_in_free_text",
			];
		case "payment_review":
			return [
				"operator_handoff_payment_review",
				"wait_for_verified_payment_state",
			];
		case "office_pickup":
			return [
				"record_office_pickup_preference",
				order?.paymentVerified
					? "operator_handoff_after_verified_payment"
					: "wait_for_verified_payment_before_payout_details",
			];
		case "payout":
			return [
				order?.paymentVerified
					? "operator_handoff_payout"
					: "wait_for_verified_payment_state",
				"issue_payout_only_if_tool_or_state_allows",
			];
		case "operator_handoff":
			return ["escalate_to_operator", "ask_one_needed_clarifier"];
		case "cancelled":
			return ["close_current_exchange", "invite_new_quote_if_customer_returns"];
		case "general":
			return [
				"answer_from_state",
				"collect_missing_fields",
				"escalate_if_state_missing",
			];
	}
}

function forbiddenClaimsFor(
	input: ExchangeAnswerQualityInput,
	_contract: ExchangeResponseContract,
): string[] {
	const state = input.state;
	const claims = new Set([
		"rate_or_fee_not_in_state_or_tool",
		"fresh_requisites_without_tool",
		"kyc_verified_without_state",
		"payment_verified_without_state",
		"payout_completed_without_state",
		"operator_approval_promised_without_operator",
	]);

	if (hasPendingKyc(input))
		claims.add("payment_requisites_before_kyc_verified");
	if (!hasVerifiedPayment(state)) {
		claims.add("payout_ready_without_payment_verification");
	}
	if (!hasPayoutReady(state)) claims.add("payout_code_or_eta_without_state");
	if (!state?.order?.payoutLocation) claims.add("office_address_not_in_state");

	return Array.from(claims);
}

const DEBUG_URL_RE = /\bhttps?:\/\/\S+/giu;
const DEBUG_CRYPTO_ADDRESS_RE =
	/\b(?:T[A-Za-z0-9]{25,}|0x[a-fA-F0-9]{32,}|bc1[a-z0-9]{20,})\b/giu;
const DEBUG_CARDISH_RE = /\b\d(?:[ -]?\d){11,18}\b/gu;
const DEBUG_FILE_RE =
	/\b[\w.-]*(?:passport|паспорт|receipt|чек|document|документ)[\w.-]*\.(?:jpg|jpeg|png|pdf|heic)\b/giu;

export function redactExchangeDebugText(
	value: string | null | undefined,
): string {
	if (!value) return "";
	return value
		.replace(DEBUG_URL_RE, "[redacted_url]")
		.replace(DEBUG_CRYPTO_ADDRESS_RE, "[redacted_crypto_address]")
		.replace(DEBUG_CARDISH_RE, "[redacted_number]")
		.replace(DEBUG_FILE_RE, "[redacted_file]");
}

function statePackList(
	context: ExchangeAnswerQualityContext,
	key: string,
): string[] {
	const line = context.statePack
		.split("\n")
		.find((item) => item.startsWith(`${key}: `));
	if (!line) return [];
	const value = line.slice(key.length + 2).trim();
	if (!value || value === "none") return [];
	return value.split(" | ").map(redactExchangeDebugText).filter(Boolean);
}

function fallbackPathForGuard(
	guard: ExchangePolicyGuardResult | null | undefined,
): string | null {
	if (!guard) return null;
	if (guard.ok) return "allowed";
	switch (guard.reason) {
		case "kyc_auto_verified":
			return "kyc_review_fallback";
		case "payment_auto_verified":
			return "payment_review_fallback";
		case "payout_auto_completed":
			return "payout_review_fallback";
		case "requisites_while_kyc_pending":
			return "kyc_requisites_safe_fallback";
		case "unbacked_quote":
			return "quote_safe_fallback";
		case "unbacked_requisites":
			return "requisites_safe_fallback";
		case "unbacked_payout_code":
			return "payout_safe_fallback";
		case "rate_negotiation":
			return "operator_rate_fallback";
		default:
			return "exchange_safe_fallback";
	}
}

export function buildExchangeAnswerQualityDebugPayload(input: {
	context: ExchangeAnswerQualityContext;
	path?: "llm" | "rag" | "replay";
	guard?: ExchangePolicyGuardResult | null;
	event?: "context" | "guard";
}): ExchangeAnswerQualityDebugPayload {
	const handoff = exchangeOperatorHandoffForContext(input.context);
	const guard = input.guard ?? null;
	return {
		event: input.event ?? (guard ? "guard" : "context"),
		...(input.path ? { path: input.path } : {}),
		contractId: input.context.contract.id,
		deterministic: input.context.trace.deterministic,
		stageSlug: input.context.trace.stageSlug,
		orderId: input.context.trace.orderId,
		orderStatus: input.context.trace.orderStatus,
		verificationStatus: input.context.trace.verificationStatus,
		flags: input.context.trace.flags.map(redactExchangeDebugText),
		stateSummary: {
			knownFields: statePackList(input.context, "known_fields"),
			missingFields: statePackList(input.context, "missing_fields"),
			allowedNextActions: statePackList(input.context, "allowed_next_actions"),
			forbiddenClaims: statePackList(input.context, "forbidden_claims"),
		},
		handoff: {
			reason: handoff?.reason ?? null,
			reviewPath: handoff?.reviewPath ?? input.context.handoff.reviewPath,
			priority: handoff?.priority ?? null,
			accepted: input.context.handoff.accepted
				? redactExchangeDebugText(input.context.handoff.accepted)
				: null,
			pending: input.context.handoff.pending
				? redactExchangeDebugText(input.context.handoff.pending)
				: null,
			context: input.context.handoff.context
				? redactExchangeDebugText(input.context.handoff.context)
				: null,
		},
		guard: guard
			? {
					ok: guard.ok,
					reason: guard.reason ?? null,
					fallbackPath: fallbackPathForGuard(guard),
					fallbackText: guard.ok ? null : redactExchangeDebugText(guard.text),
				}
			: null,
	};
}

function joinDebugList(items: string[]): string {
	return items.length > 0 ? items.join(",") : "-";
}

export function formatExchangeAnswerQualityDebugTrace(
	payload: ExchangeAnswerQualityDebugPayload,
): string[] {
	const lines = [
		[
			`debug_contract=${payload.contractId}`,
			`deterministic=${payload.deterministic ? "yes" : "no"}`,
			`stage=${payload.stageSlug ?? "-"}`,
			`order=${payload.orderId ?? "-"}`,
			`orderStatus=${payload.orderStatus ?? "-"}`,
			`verification=${payload.verificationStatus ?? "-"}`,
			`flags=${joinDebugList(payload.flags)}`,
		].join(" "),
		[
			"debug_state",
			`known=${joinDebugList(payload.stateSummary.knownFields)}`,
			`missing=${joinDebugList(payload.stateSummary.missingFields)}`,
			`allowed=${joinDebugList(payload.stateSummary.allowedNextActions)}`,
			`forbidden=${joinDebugList(payload.stateSummary.forbiddenClaims)}`,
		].join(" "),
	];
	if (
		payload.handoff.reason ||
		payload.handoff.reviewPath ||
		payload.handoff.pending
	) {
		lines.push(
			[
				"debug_handoff",
				`reason=${payload.handoff.reason ?? "-"}`,
				`reviewPath=${payload.handoff.reviewPath ?? "-"}`,
				`priority=${payload.handoff.priority ?? "-"}`,
				`accepted=${payload.handoff.accepted ?? "-"}`,
				`pending=${payload.handoff.pending ?? "-"}`,
			].join(" "),
		);
	}
	if (payload.guard) {
		lines.push(
			[
				"debug_guard",
				`ok=${payload.guard.ok ? "yes" : "no"}`,
				`reason=${payload.guard.reason ?? "-"}`,
				`fallbackPath=${payload.guard.fallbackPath ?? "-"}`,
				`fallbackText=${payload.guard.fallbackText ?? "-"}`,
			].join(" "),
		);
	}
	return lines.map(redactExchangeDebugText);
}

function handoffFactsFor(
	input: ExchangeAnswerQualityInput,
	contract: ExchangeResponseContract,
): ExchangeAnswerQualityHandoffFacts {
	const state = input.state;
	const amount = orderAmountLabel(state);
	const rail = railLabel(state);
	const network = formatMaybe(state?.order?.network);
	const orderContext = safeOrderContext(state);

	if (contract.id === "kyc_submitted") {
		return {
			accepted: "Клиент отправил KYC-материалы: документ/фото/видео.",
			pending:
				"Верификация ждёт результата; реквизиты, оплата и выдача не открываются до review outcome.",
			reviewPath: "operator_or_external_kyc",
			context: `${orderContext}; media=document/video from latest inbound; raw document contents are not logged.`,
			urgency:
				"high: KYC blocks payment requisites and the next exchange step.",
			amount,
			rail,
			network,
		};
	}

	if (
		contract.id === "kyc_requested" &&
		input.state?.verification?.status &&
		/(?:reject|declin|denied|fail|отказ|отклон|не\s+прош)/iu.test(
			input.state.verification.status,
		)
	) {
		return {
			accepted:
				"Клиент ждёт следующий шаг после отклонённой или неподтверждённой KYC-проверки.",
			pending:
				"Нужно решить, какие KYC-материалы запросить повторно; payment/requisites остаются закрыты.",
			reviewPath: "operator_or_external_kyc",
			context: `${orderContext}; verificationStatus=${input.state.verification.status}`,
			urgency: "high: rejected KYC blocks payment requisites and payout.",
			amount,
			rail,
			network,
		};
	}

	if (contract.id === "payment_review") {
		return {
			accepted: input.state?.order?.paymentProofReceived
				? "Чек/скрин оплаты уже принят в заявке."
				: "Клиент отправил чек/скрин оплаты в последнем сообщении.",
			pending:
				"Сверка платежа не завершена; payout нельзя запускать до paymentVerified=true.",
			reviewPath: "operator_or_payment_service",
			context: `${orderContext}; proof media=receipt/screenshot from latest inbound or persisted proof.`,
			urgency:
				"high: customer is waiting for payment review before THB payout.",
			amount,
			rail,
			network,
		};
	}

	if (contract.id === "office_pickup" && state?.order?.paymentVerified) {
		return {
			accepted:
				"Клиент хочет получить THB наличными в офисе после проверенной оплаты.",
			pending:
				"Нужно подтвердить точку, время и порядок выдачи; завершение payout ещё не зафиксировано.",
			reviewPath: "operator_or_payout_service",
			context: orderContext,
			urgency:
				"high: payment is verified and customer expects office pickup details.",
			amount,
			rail,
			network,
		};
	}

	if (contract.id === "payout" && state?.order?.paymentVerified) {
		return {
			accepted: "Оплата уже отмечена как проверенная в state.",
			pending:
				"Нужно подтвердить payout method/code/address or completion; do not invent payout details.",
			reviewPath: "operator_or_payout_service",
			context: orderContext,
			urgency: "high: verified payment is waiting for payout execution.",
			amount,
			rail,
			network,
		};
	}

	if (contract.id === "operator_handoff") {
		return {
			accepted:
				"Клиент запросил оператора, индивидуальные условия или ручное решение.",
			pending:
				"Нужно ответить человеку в диалоге; AI не должен обещать неподтверждённые условия.",
			reviewPath: "manual_operator",
			context: orderContext,
			urgency: "normal: manual business decision requested.",
			amount,
			rail,
			network,
		};
	}

	return {
		accepted: null,
		pending: null,
		reviewPath: null,
		context: null,
		urgency: null,
		amount,
		rail,
		network,
	};
}

function flagsFor(input: ExchangeAnswerQualityInput): string[] {
	const state = input.state;
	const text = input.userMessageText;
	return [
		hasPendingKyc(input) ? "kyc_pending" : null,
		hasRejectedKyc(state) ? "kyc_rejected" : null,
		state?.verification?.verified === true ? "kyc_verified" : null,
		hasRequisitesIssued(state) ? "requisites_issued" : null,
		state?.order?.paymentProofReceived ? "payment_proof_received" : null,
		hasVerifiedPayment(state) ? "payment_verified" : null,
		hasPayoutReady(state) ? "payout_ready" : null,
		isPaymentProofSubmission(text) ? "message_payment_proof" : null,
		isKycSubmission(text) ? "message_kyc_attachment" : null,
		isOfficePickupRequest(text) ? "message_office_pickup" : null,
		asksForOperator(text) ? "message_operator_request" : null,
	]
		.filter(Boolean)
		.map(String);
}

function selectExchangeResponseContract(
	input: ExchangeAnswerQualityInput,
): ExchangeResponseContract {
	const state = input.state;
	const text = input.userMessageText;
	const pendingKyc = hasPendingKyc(input);
	const rejectedKyc = hasRejectedKyc(state);

	if (isCancellation(text)) return CONTRACTS.cancelled;
	if ((pendingKyc || rejectedKyc) && isKycSubmission(text))
		return CONTRACTS.kyc_submitted;
	if (rejectedKyc) return CONTRACTS.kyc_requested;
	if (pendingKyc) return CONTRACTS.kyc_requested;
	if (isPaymentProofSubmission(text) || paymentNeedsReview(state))
		return CONTRACTS.payment_review;
	if (isOfficePickupRequest(text)) return CONTRACTS.office_pickup;
	if (hasVerifiedPayment(state) || hasPayoutReady(state) || asksForPayout(text))
		return CONTRACTS.payout;
	if (state?.order && asksForPaymentOrRequisites(text))
		return CONTRACTS.payment_requisites;
	if (hasRequisitesIssued(state) || state?.order?.status === "awaiting_payment")
		return CONTRACTS.payment_requisites;
	if (asksForOperator(text)) return CONTRACTS.operator_handoff;
	if (/(?:подтверждаю|согласен|согласна|готов|готова|оформляйте)/iu.test(text))
		return CONTRACTS.quote_confirmed;
	if (asksForQuote(text)) return CONTRACTS.quote;
	return CONTRACTS.general;
}

function deterministicReplyFor(
	input: ExchangeAnswerQualityInput,
	contract: ExchangeResponseContract,
): string | null {
	const state = input.state;
	const order = state?.order;
	const text = input.userMessageText;
	const pendingKyc = hasPendingKyc(input);
	const rejectedKyc = hasRejectedKyc(state);

	if (contract.id === "cancelled") {
		return [
			"Понял, обмен не оформляю.",
			"Если решите продолжить позже, напишите сумму и валюту заново — рассчитаю актуальный курс и подскажу следующий шаг.",
		].join("\n\n");
	}

	if ((pendingKyc || rejectedKyc) && isKycSubmission(text)) {
		return [
			"Принял документ/видео для верификации.",
			"Сейчас pending: материалы ждут review outcome, поэтому реквизиты и оплата пока не открываются.",
			"Проверку делает внешний KYC-сервис или оператор. Я не провожу KYC автоматически в чате; после результата продолжим оформление заявки.",
		].join("\n\n");
	}

	if (rejectedKyc) {
		return [
			"KYC сейчас в статусе повторной проверки: оператор или KYC-сервис должен проверить материалы заново.",
			"Я не могу выдать реквизиты или перейти к выдаче до повторной проверки. Пришлите корректный документ/видео или дождитесь ответа оператора в этом диалоге.",
		].join("\n\n");
	}

	if (
		pendingKyc &&
		/(?:без\s+верификац|зачем|обязательн|почему)/iu.test(text)
	) {
		return [
			"Да, верификация обязательна для обмена.",
			"Нужно прислать документ, удостоверяющий личность, и короткое видео/кружок с ФИО и фразой о направлении обмена.",
			"После проверки продолжим заявку и выдадим следующий шаг.",
		].join("\n\n");
	}

	if (
		pendingKyc &&
		/(?:паспорт|документ|что\s+подойдет|какие\s+документы)/iu.test(text)
	) {
		return [
			"Паспорт РФ подойдёт.",
			"Пришлите фото/скан паспорта и короткое видео/кружок, где вы произносите ФИО и фразу: «Я хочу обменять [сумма] [валюта] на тайские баты».",
			"После проверки оформим заявку дальше.",
		].join("\n\n");
	}

	if (pendingKyc && asksForPaymentOrRequisites(text)) {
		return [
			"Сначала нужно пройти верификацию: документ + короткое видео/кружок.",
			"После проверки зафиксируем способ выдачи и дадим конкретные реквизиты/инструкцию. Получение на тайский банк, наличными в офисе или через доступный вариант выдачи можно согласовать после KYC.",
		].join("\n\n");
	}

	if (
		order &&
		!order.requisitesIssued &&
		!order.paymentVerified &&
		asksForPaymentOrRequisites(text)
	) {
		return [
			"Реквизиты пока не выданы системой.",
			"Я не буду придумывать карту, QR или кошелёк в чате. Как только заявка и проверки разрешат оплату, система выдаст реквизиты или оператор подтвердит следующий шаг.",
		].join("\n\n");
	}

	if (order && paymentNeedsReview(state)) {
		return [
			"Чек/скрин уже принят и ждёт проверки.",
			"Сейчас pending: сверка платежа не завершена, поэтому выдачу THB ещё не запускаю.",
			"Проверяет оператор или платёжный сервис. Я не подтверждаю оплату автоматически в чате; после результата продолжим выдачу по выбранному способу.",
		].join("\n\n");
	}

	if (
		order &&
		!order.paymentVerified &&
		(hasRequisitesIssued(state) || order.status === "awaiting_payment") &&
		claimsPaymentWithoutProof(text)
	) {
		return [
			"Понял, что оплату отправили, но без чека или скрина я не могу передать её на проверку как подтверждённую.",
			"Пришлите чек/скрин перевода. После этого оператор или платёжный сервис проверит оплату, и мы продолжим выдачу THB по выбранному способу.",
		].join("\n\n");
	}

	if (
		order &&
		!order.paymentVerified &&
		(hasRequisitesIssued(state) || order.status === "awaiting_payment") &&
		isPaymentProofSubmission(text)
	) {
		return [
			"Принял чек/скрин оплаты.",
			"Сейчас pending: сверка платежа не завершена, поэтому выдачу THB ещё не запускаю.",
			"Проверяет оператор или платёжный сервис. Я не подтверждаю оплату автоматически в чате; после результата продолжим выдачу по выбранному способу.",
		].join("\n\n");
	}

	if (order && isOfficePickupRequest(text)) {
		if (order.paymentVerified) {
			const location = order.payoutLocation
				? ` Локация в заявке: ${order.payoutLocation}.`
				: "";
			return [
				"Оплата отмечена как проверенная в системе.",
				`Передаю оператору выдачу THB в офисе: он подтвердит время, точку и порядок получения.${location}`,
			].join("\n\n");
		}

		return [
			order.payoutMethod === "office_cash"
				? "В заявке стоит получение наличных в офисе."
				: "Получение в офисе можно вести как способ выдачи.",
			"Сначала завершаем проверку KYC и оплаты. После этого оператор подтвердит адрес офиса, время и порядок выдачи.",
		].join("\n\n");
	}

	if (
		order?.paymentVerified &&
		!order.payoutCompleted &&
		contract.id === "payout"
	) {
		return [
			"Оплата отмечена как проверенная в системе.",
			"Передаю заявку оператору на выдачу THB по выбранному способу. Код, адрес или точное время выдачи не придумываю в чате — их подтверждает оператор или payout-сервис.",
		].join("\n\n");
	}

	if (asksForOperator(text)) {
		return [
			"Передаю вопрос оператору.",
			"Он проверит условия по заявке и ответит в этом диалоге. До подтверждения человека я не буду называть неподтверждённый курс, адрес, реквизиты или статус проверки.",
		].join("\n\n");
	}

	return null;
}

export function buildExchangeAnswerQualityContext(
	input: ExchangeAnswerQualityInput,
): ExchangeAnswerQualityContext {
	const contract = selectExchangeResponseContract(input);
	const deterministicReply = deterministicReplyFor(input, contract);
	const flags = flagsFor(input);
	const state = input.state;
	const knownFields = knownFieldsFor(state);
	const missingFields = missingFieldsFor(input, contract);
	const allowedNextActions = allowedNextActionsFor(input, contract);
	const forbiddenClaims = forbiddenClaimsFor(input, contract);
	const handoff = handoffFactsFor(input, contract);
	const trace: ExchangeAnswerQualityTrace = {
		contractId: contract.id,
		stageSlug: state?.stageSlug ?? null,
		orderId: state?.order?.id ?? null,
		orderStatus: state?.order?.status ?? null,
		verificationStatus: state?.verification?.status ?? null,
		kycPending: hasPendingKyc(input),
		paymentVerified: hasVerifiedPayment(state),
		payoutReady: hasPayoutReady(state),
		deterministic: deterministicReply !== null,
		flags,
	};

	const statePack = [
		"EXCHANGE OPS STATE PACK",
		`response_contract: ${contract.id} (${contract.title})`,
		`tone: ${contract.tone}`,
		`required_facts: ${contract.requiredFacts.join(" | ")}`,
		`cta: ${contract.cta}`,
		`handoff_behavior: ${contract.handoffBehavior}`,
		`stage: ${state?.stageSlug ?? "unknown"}`,
		verificationLine(state),
		orderLine(state),
		`known_fields: ${knownFields.join(" | ")}`,
		`missing_fields: ${missingFields.length ? missingFields.join(" | ") : "none"}`,
		`allowed_next_actions: ${allowedNextActions.join(" | ")}`,
		`forbidden_claims: ${forbiddenClaims.join(" | ")}`,
		state?.order
			? [
					`payment: requisitesIssued=${state.order.requisitesIssued ? "yes" : "no"}`,
					`proofReceived=${state.order.paymentProofReceived ? "yes" : "no"}`,
					`verified=${state.order.paymentVerified ? "yes" : "no"}`,
				].join("; ")
			: "payment: no active order",
		state?.order
			? [
					`payout: ready=${state.order.payoutReady ? "yes" : "no"}`,
					`codeIssued=${state.order.payoutCodeIssued ? "yes" : "no"}`,
					`completed=${state.order.payoutCompleted ? "yes" : "no"}`,
				].join("; ")
			: "payout: no active order",
		`goal: ${contract.goal}`,
		`allowed: ${contract.allowed.join(" | ")}`,
		`forbidden: ${contract.forbidden.join(" | ")}`,
		`next_step: ${contract.nextStep}`,
		"composition_rules: отвечай по-русски, 2-5 коротких строк; не раскрывай и не придумывай реквизиты; не подтверждай KYC, оплату или выдачу без tool/persisted state; если нужен человек или внешний сервис, прямо скажи, что передаёшь оператору.",
	].join("\n");

	return { contract, statePack, trace, handoff, deterministicReply };
}

export function exchangeOperatorHandoffForContext(
	context: ExchangeAnswerQualityContext,
): OperatorHandoffMeta | null {
	if (!context.deterministicReply) return null;
	const contractId = context.contract.id;
	const facts = context.handoff;
	const baseMeta = {
		contractId,
		...(context.trace.orderId ? { orderId: context.trace.orderId } : {}),
		...(context.trace.stageSlug ? { stageSlug: context.trace.stageSlug } : {}),
		...(facts.accepted ? { accepted: facts.accepted } : {}),
		...(facts.pending ? { pending: facts.pending } : {}),
		...(facts.reviewPath ? { reviewPath: facts.reviewPath } : {}),
		...(facts.context ? { context: facts.context } : {}),
		...(facts.urgency ? { urgency: facts.urgency } : {}),
		...(facts.amount ? { amount: facts.amount } : {}),
		...(facts.rail ? { rail: facts.rail } : {}),
		...(facts.network ? { network: facts.network } : {}),
	};
	if (contractId === "kyc_submitted") {
		return {
			reason: "kyc_review",
			title: "KYC: проверить документ/видео",
			action:
				"Проверить KYC-материалы через внешний KYC-сервис, если он подключён, или выполнить manual operator review. После результата выставить verified/rejected; не выдавать реквизиты до verified outcome.",
			...baseMeta,
			priority: "high",
		};
	}
	if (
		contractId === "kyc_requested" &&
		context.trace.flags.includes("kyc_rejected")
	) {
		return {
			reason: "kyc_review",
			title: "KYC: повторная проверка",
			action:
				"Разобрать rejected/pending KYC outcome: проверить причину, запросить корректные материалы или отправить во внешний KYC-сервис. Payment/requisites держать закрытыми до verified outcome.",
			...baseMeta,
			priority: "high",
		};
	}
	if (contractId === "payment_review") {
		return {
			reason: "payment_review",
			title: "Оплата: проверить чек/скрин",
			action:
				"Сверить чек/скрин с поступлением через платёжный сервис или manual payment review. После сверки отметить paymentVerified=true либо запросить новый proof; payout не запускать до verified.",
			...baseMeta,
			priority: "high",
		};
	}
	if (contractId === "office_pickup" && context.trace.paymentVerified) {
		return {
			reason: "office_payout",
			title: "Выдача: подтвердить офис",
			action:
				"Payment verified. Подтвердить клиенту офис/время/порядок выдачи или передать payout-сервису; не придумывать адрес/ETA вне state.",
			...baseMeta,
			priority: "high",
		};
	}
	if (contractId === "payout" && context.trace.paymentVerified) {
		return {
			reason: "payout_review",
			title: "Выдача: подтвердить payout",
			action:
				"Payment verified. Подтвердить payout method/code/address/completion через оператора или payout-сервис; не выдавать код, адрес или ETA без подтверждённого state.",
			...baseMeta,
			priority: "high",
		};
	}
	if (contractId === "operator_handoff") {
		return {
			reason: "operator_request",
			title: "Нужен оператор",
			action:
				"Клиент запросил ручное решение или нестандартные условия. Проверить заявку и ответить в диалоге; не обещать индивидуальный курс или approval до ручного решения.",
			...baseMeta,
			priority: "normal",
		};
	}
	return null;
}

export function logExchangeAnswerQualityTrace(input: {
	tenantId: number;
	conversationId: number;
	path: "llm" | "rag";
	context: ExchangeAnswerQualityContext;
	guard?: ExchangePolicyGuardResult | null;
	event?: "context" | "guard";
}): void {
	if (
		process.env.NODE_ENV === "test" &&
		process.env.EXCHANGE_ANSWER_TRACE !== "1"
	) {
		return;
	}
	const payload = buildExchangeAnswerQualityDebugPayload({
		context: input.context,
		path: input.path,
		guard: input.guard ?? null,
		event: input.event,
	});
	console.debug(
		"[exchange-answer-quality]",
		JSON.stringify({
			tenantId: input.tenantId,
			conversationId: input.conversationId,
			...payload,
		}),
	);
}
