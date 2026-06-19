import type { OutboundEnvelope } from "@chatman-media/channel-core";
import {
	type AnyRagTool,
	buildToolTelemetry,
	DEFAULT_MAX_TOOL_CYCLES,
	runToolLoop,
	type ToolCallRecord,
} from "@chatman-media/kb";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import {
	loadRollingConversationContext,
	messageRowsToChatHistory,
	renderConversationSummaryBlock,
} from "../conversation-summary.ts";
import type { ConversationsRepo } from "../dal/conversations.ts";
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
import {
	ANY_QUOTE_CURRENCY_MENTION_RE,
	QUOTE_CURRENCY,
	type QuoteCurrency,
	resolveQuoteCurrency,
} from "../exchange-quote-currency.ts";
import type {
	ReplyStrategy,
	ReplyStrategyOutput,
	ReplyStrategyResult,
} from "../process-inbound.ts";
import {
	LLM_REPLY_BASE_SYSTEM_PROMPT,
	LLM_REPLY_TOOLS_SYSTEM_FRAGMENT,
} from "../prompts/llm-reply.ts";
import {
	buildExchangeGenericOperatorHandoff,
	buildExchangeOperatorHandoff,
} from "./exchange-operator-handoff.ts";
import {
	type ExchangePolicyState,
	guardExchangePolicy,
} from "./exchange-policy-guard.ts";
import {
	EXCHANGE_SAFE_FALLBACK,
	type ExchangeResponseGuardAction,
	type ExchangeResponseGuardFinding,
	exchangeGuardFindingFromResult,
} from "./exchange-reply-guard.ts";

/**
 * Минимальный LLM-based ReplyStrategy. Шаги на каждый inbound:
 *   1. Загрузить последние N сообщений из conversation (history).
 *   2. Собрать system prompt (template.systemPromptFragment + base).
 *   3. Послать history → ChatClient.complete().
 *   4. Вернуть OutboundEnvelope с text-частью.
 *
 * Что отсутствует (полная RAG / sales — следующая итерация):
 *   - KB search + chunks в контекст
 *   - sales-style selection и A/B routing
 *   - memory extraction в contacts.attributes_json
 *   - extractFields hook на user message
 *   - photo/voice handling (сейчас игнорируем, нет multimodal через chat)
 *
 * Truncated ответы (ChatTruncatedError) ловятся выше — strategy
 * пробрасывает их в processInbound, где попадают в sink.log; envelope
 * НЕ ставится в outbound_queue, бот молчит вместо half-формы.
 */
export interface LlmReplyStrategyOpts {
	/** Fallback template used when no per-tenant template resolver is configured. */
	template: VerticalTemplate;
	/**
	 * Optional per-tenant template resolver. Lets apps/api use the tenant's
	 * installed vertical instead of one boot-time hardcoded template.
	 */
	resolveTemplate?: (tenantId: number) => VerticalTemplate | null | undefined;
	/**
	 * Лимит сырых сообщений в history-prompt'е. Default 20. Старые сообщения
	 * при наличии conversationsRepoFor сворачиваются в rolling summary.
	 */
	historyLimit?: number;
	/**
	 * Per-tenant override окна истории (заменяет historyLimit). Резолвится из
	 * tenants.reply_history_limit; NULL/ошибка → historyLimit. Правится в админке.
	 */
	resolveHistoryLimit?: (input: {
		tenantId: number;
	}) => Promise<number | null | undefined> | number | null | undefined;
	/**
	 * #623 — per-tenant override параметров генерации из tenants.bot_settings_json
	 * (temperature / maxOutputTokens / compactAfterMessages). null-поля → дефолты.
	 */
	resolveGenerationParams?: (input: { tenantId: number }) => Promise<
		| {
				temperature?: number | null;
				maxOutputTokens?: number | null;
				compactAfterMessages?: number | null;
		  }
		| null
		| undefined
	>;
	/** Per-call temperature, default 0.7. */
	temperature?: number;
	/** Output token cap, default 600. */
	maxOutputTokens?: number;
	/**
	 * Resolver ChatClient'а. apps/api прокидывает функцию которая знает
	 * tenant_id из request scope: (tenantId) => llmRouter.resolveChat(tenantId, 'chat').
	 * Это даёт per-call swap клиента — если оператор поменял конфиг через
	 * admin-UI и invalidate'нул router, следующий resolveChat() построит
	 * нового.
	 */
	resolveChat: (tenantId: number) => ChatClient;
	/** Если возвращает true — стадия лида помечена supportMode, бот молчит. */
	resolveIsSupport?: (input: {
		tenantId: number;
		contactId: number;
	}) => Promise<boolean>;
	/**
	 * Optional factual brokered-order context for the current customer. This is
	 * prompt-only grounding; order status changes are handled by deterministic
	 * customer offer services.
	 */
	resolveServiceOrderContext?: (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
	}) => Promise<string | null> | string | null;
	/**
	 * Optional exchange workflow state snapshot for the final policy guard.
	 * Used only for exchange_v1, after LLM generation.
	 */
	resolveExchangePolicyState?: (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
	}) => Promise<ExchangePolicyState | null> | ExchangePolicyState | null;
	/**
	 * Поля заявки, собранные универсальным движком (leadFieldValues). Источник
	 * правды для форс-ответов обмена; absent/null → fallback на regex-парсинг.
	 */
	resolveExchangeCollected?: (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
	}) => Promise<ExchangeCollectedInput | null> | ExchangeCollectedInput | null;
	/**
	 * Per-tenant котируемая валюта (exchange_settings.quote_asset) для форс-текстов
	 * обмена (напр. KYC-handoff). null/absent → платформенный QUOTE_CURRENCY.
	 */
	resolveExchangeQuoteCurrency?: (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
	}) => Promise<QuoteCurrency | null> | QuoteCurrency | null;
	/** false → exchange response guard bypassed for this tenant. Default: true. */
	resolveExchangeResponseGuardEnabled?: (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
	}) => Promise<boolean> | boolean;
	resolveExchangeCustomerNoticeEnabled?: (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
	}) => Promise<boolean> | boolean;
	/**
	 * Опциональный резолвер agentic-инструментов (напр. расчёт курса обмена).
	 * Если задан и вернул непустой список, а ChatClient умеет completeWithTools —
	 * strategy прогоняет tool-loop, чтобы бот мог дать конкретный ответ
	 * (курс/сумму) даже без RAG/эмбеддингов, а не уходить в «уточню у партнёра».
	 */
	resolveTools?: (input: {
		tenantId: number;
		conversationId: number;
		contactId?: number;
	}) => Promise<AnyRagTool[]> | AnyRagTool[];
	/**
	 * Optional post-generation telemetry sink for agentic tool calls. Called only
	 * after tool execution finishes, outside the split-transaction LLM phase.
	 */
	recordToolCalls?: (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
		userMessageText: string;
		assistantText: string;
		toolCalls: readonly ToolCallRecord[];
		guardFindings?: readonly ExchangeResponseGuardFinding[];
	}) => Promise<void> | void;
	/**
	 * Conversation compaction threshold. Default 20. Отключить: 0 или Infinity.
	 */
	compactAfterMessages?: number;
	/** Hard cap for injected conversation summary. Default 600 chars. */
	summaryMaxChars?: number;
}

type ExchangeQuoteArgs = {
	asset: string;
	amount: number;
	network?: string;
};

type ExchangeOrderArgs = ExchangeQuoteArgs & {
	amountMode?: "source_amount" | "target_thb";
	paymentMethod?: string;
	payoutMethod?: string;
};

type ExchangeForcedReply = {
	text: string;
	toolCalls: ToolCallRecord[];
};

// Интент-классификатор follow-up котировки (#654: KEEP — это не сбор полей).
// Гейтит форс-котировку вместе с amountSetThisTurn: «посчитай/курс/сколько».
const EXCHANGE_QUOTE_INTENT_RE =
	/курс|rate|сколько|получ(?:у|ится|ить)|итого|посчитай|рассчитай/i;
// Явный вопрос ИМЕННО про значение курса — тогда курс показываем (проактивная
// котировка его прячет). НЕ матчит «курс устраивает/ок». \b/\w не юзаем —
// в JS они ASCII-only и ломаются на кириллице.
const EXCHANGE_RATE_QUESTION_RE =
	/(?:как(?:ой|ому|ая)|по\s+как(?:ому|ой)|нужен|нужна|не\s+хватает|назов|скажите|сообщите|что\s+за|информаци)[^.?!]{0,20}курс|курс[^.?!а-яa-z]{0,3}\?|какой\s+rate/iu;
const EXCHANGE_ORDER_CONFIRMATION_WORDS = new Set([
	"да",
	"давай",
	"давайте",
	"ок",
	"ok",
	"okay",
	"окей",
	"супер",
	"класс",
	"топ",
	"отл",
	"отлично",
	"хорошо",
	"хор",
	"норм",
	"нормально",
	"подходит",
	"годится",
	"годно",
	"ага",
	"угу",
	"идёт",
	"идет",
	"пойдёт",
	"пойдет",
	"беру",
	"готов",
	"готовы",
	"оформляй",
	"оформляем",
	"оформить",
	"оформи",
	"создавай",
	"создавайте",
	"делаем",
	"погнали",
	"вперёд",
	"вперед",
	"согласен",
	"согласна",
	"договорились",
	"начинаем",
	"поехали",
	"лады",
	"ладно",
	"подтверждаю",
	"подтверждаем",
]);
const EXCHANGE_KYC_TOPIC_RE = /верификац|kyc|документ|паспорт|видео|кружок/i;
const EXCHANGE_KYC_MATERIAL_SENT_RE =
	/(?:отправил|отправила|прислал|прислала|загрузил|загрузила|вот|держи|лови)[^.!\n]{0,80}(?:видео|кружок|документ|паспорт)|(?:видео|кружок|документ|паспорт)[^.!\n]{0,80}(?:отправил|отправила|прислал|прислала|загрузил|загрузила)/i;
// Валюта выдачи — per-tenant (exchange_settings.quote_asset), не платформенный
// дефолт: иначе THB-тенант видел «способ получения песо».
function buildExchangeKycHandoffText(currency: QuoteCurrency): string {
	return [
		"Да. Перед реквизитами нужна верификация клиента.",
		"Пришлите короткое видео: лицо и документ в кадре. Оператор или внешний сервис проведёт проверку личности.",
		`После проверки продолжим заявку: способ получения ${currency.wordGen}, реквизиты и финальное подтверждение.`,
	].join("\n");
}

function exchangeReplyOutput(input: {
	channelId: number;
	externalUserId: string;
	text: string;
	operatorHandoff: ReturnType<typeof buildExchangeOperatorHandoff>;
	customerNoticeEnabled: boolean;
}): OutboundEnvelope[] | ReplyStrategyOutput {
	if (!input.operatorHandoff) {
		return [
			{
				channelId: String(input.channelId),
				externalUserId: input.externalUserId,
				parts: [{ kind: "text", text: input.text }],
			},
		];
	}
	const envelopes = input.customerNoticeEnabled
		? [
				{
					channelId: String(input.channelId),
					externalUserId: input.externalUserId,
					parts: [{ kind: "text" as const, text: input.text }],
				},
			]
		: [];
	return {
		envelopes,
		operatorHandoffs: [input.operatorHandoff],
		autoTakeover: true,
		customerNoticeSent: envelopes.length > 0,
	};
}

/** Максимум попыток перегенерации exchange-ответа за один ход (см. цикл в generate). */
const MAX_EXCHANGE_REPLY_ATTEMPTS = 3;

/**
 * Корректирующая подсказка для ПЕРЕгенерации exchange-ответа, который не прошёл
 * (гард переписал выдуманный курс/реквизиты ИЛИ бот ушёл в отписку «уточню у
 * оператора»). Добавляется системным сообщением к следующей попытке: цель —
 * заставить модель ответить по существу (посчитать инструментом / спросить
 * недостающее), а не повторить фабрикацию и не обещать оператора.
 */
function buildExchangeRetryHint(guarded: {
	reason?: string | null;
	requiredFixes?: readonly string[];
}): string {
	const fixes = guarded.requiredFixes?.length
		? guarded.requiredFixes.join(" ")
		: "";
	return [
		"Твой предыдущий черновик НЕ ГОДИТСЯ и клиенту НЕ отправлен.",
		guarded.reason ? `Причина отклонения: ${guarded.reason}.` : "",
		fixes,
		"Дай корректный ответ прямо сейчас: посчитай курс/сумму через инструмент расчёта или спроси недостающие данные. НЕ выдумывай числа и реквизиты.",
		"НЕ пиши «уточню у оператора» и не обещай вернуться позже — отвечай по существу.",
	]
		.filter(Boolean)
		.join(" ");
}

/**
 * Кому-то нужен оператор? Порядок резолва хэндоффа для exchange-ответа:
 *   1) сигнал из tool-результата/состояния (buildExchangeOperatorHandoff);
 *   2) guard потребовал escalate/block — явный generic с причиной guard'а;
 *   3) исчерпаны попытки перегенерации (retriesExhausted): бот несколько раз
 *      подряд не смог дать нормальный ответ (выдумывал курс/реквизиты или уходил
 *      в отписку «уточню у оператора») → передаём диалог оператору. Триггер по
 *      СЧЁТЧИКУ неудачных попыток, не по тексту ответа.
 */
function resolveExchangeOperatorHandoff(input: {
	text: string;
	action: ExchangeResponseGuardAction;
	reason: string | null;
	telemetry: Parameters<typeof buildExchangeOperatorHandoff>[0]["telemetry"];
	state: ExchangePolicyState | null;
	retriesExhausted: boolean;
}): ReturnType<typeof buildExchangeOperatorHandoff> {
	const signalled = buildExchangeOperatorHandoff({
		text: input.text,
		telemetry: input.telemetry,
		state: input.state,
	});
	if (signalled) return signalled;
	if (input.action === "escalate" || input.action === "block") {
		return buildExchangeGenericOperatorHandoff({
			state: input.state,
			context: input.reason,
		});
	}
	if (input.retriesExhausted) {
		return buildExchangeGenericOperatorHandoff({
			state: input.state,
			context: "bot_uncertain",
		});
	}
	return null;
}

function isExchangeOrderConfirmationSeparator(ch: string): boolean {
	return (
		ch === " " ||
		ch === "\t" ||
		ch === "\n" ||
		ch === "\r" ||
		ch === "\f" ||
		ch === "\v" ||
		ch === "!" ||
		ch === "." ||
		ch === ","
	);
}

function isExchangeOrderConfirmation(text: string): boolean {
	const trimmed = text.trim().toLowerCase();
	if (!trimmed || trimmed.length > 80) return false;

	let token = "";
	let seen = false;
	for (const ch of trimmed) {
		if (isExchangeOrderConfirmationSeparator(ch)) {
			if (!token) continue;
			if (!EXCHANGE_ORDER_CONFIRMATION_WORDS.has(token)) return false;
			seen = true;
			token = "";
			continue;
		}
		token += ch;
	}
	if (token) {
		if (!EXCHANGE_ORDER_CONFIRMATION_WORDS.has(token)) return false;
		seen = true;
	}
	return seen;
}

/**
 * Единый снимок собранных полей заявки из реплик клиента (см. rag-reply).
 * Источник правды для грунтинга промпта, вопроса оплаты и сводки.
 */
type ExchangeCollected = {
	asset: string | null;
	amount: number | null;
	network: string | null;
	payoutMethod: string | null;
	paymentMethod: string | null;
	missing: string[];
};

/** Сырые поля из универсального движка (apps/api → ctx). См. rag-reply. */
export interface ExchangeCollectedInput {
	asset?: string;
	amount?: number;
	network?: string;
	payoutMethod?: string;
	paymentMethod?: string;
	/**
	 * Per-turn сигнал из универсального движка (#654): сумму (amount_from) на ЭТОМ
	 * ходе (пере)задал field-extractor. Гейт форс-котировки. См. rag-reply.
	 */
	amountSetThisTurn?: boolean;
	/** Аналогично amountSetThisTurn, но для актива (asset_from). */
	assetSetThisTurn?: boolean;
}

function buildExchangeCollected(
	injected?: ExchangeCollectedInput | null,
): ExchangeCollected {
	// Источник правды — универсально собранное (ctx из leadFieldValues). #654:
	// regex-парсинг реплик удалён, проекция теперь чистая. asset/network приводим
	// к ВЕРХНЕМУ регистру (формат тулов/меток): инжект приходит как usdt/trc20.
	const asset = injected?.asset ? injected.asset.toUpperCase() : null;
	const network = injected?.network ? injected.network.toUpperCase() : null;
	const amount = injected?.amount ?? null;
	const payoutMethod = injected?.payoutMethod ?? null;
	const paymentMethod = injected?.paymentMethod ?? null;
	const missing: string[] = [];
	if (!asset || !amount) missing.push("amount");
	if (asset && EXCHANGE_USDT_RE.test(asset) && !network)
		missing.push("network");
	if (asset && !payoutMethod) missing.push("payout");
	if (asset === "RUB" && !paymentMethod) missing.push("payment");
	return { asset, amount, network, payoutMethod, paymentMethod, missing };
}

// Метки для сводки/грунтинга — без слов оплат*/перевод/карта/qr/сбп/реквизит,
// иначе текст с числом котировки триггерит requisites-guard.
function exchangePayoutLabel(method: string | null): string | null {
	switch (method) {
		case "atm":
			return "снятие в банкомате";
		case "office_cash":
			return "наличные в офисе";
		case "courier_cash":
			return "доставка курьером";
		case "thai_bank_transfer":
			return "зачисление на тайский счёт";
		default:
			return null;
	}
}

function exchangePaymentLabel(method: string | null): string | null {
	switch (method) {
		case "sbp_qr":
			return "по коду в банк-приложении";
		case "card_transfer":
		case "bank_transfer":
			return "банковским зачислением";
		default:
			return null;
	}
}

/** Грунтинг «что уже собрано» для system-prompt (идёт в промпт, не в ответ). */
function renderExchangeCollectedGrounding(c: ExchangeCollected): string | null {
	if (!c.asset || !c.amount) return null;
	const dir = `${c.amount} ${c.asset}${c.network ? ` (${c.network})` : ""}`;
	const payout = exchangePayoutLabel(c.payoutMethod) ?? "—";
	const payment =
		c.asset === "RUB"
			? (exchangePaymentLabel(c.paymentMethod) ?? "—")
			: "со счёта/кошелька клиента";
	return [
		"КОНТЕКСТ ЗАЯВКИ НА ОБМЕН (клиент это уже назвал — НЕ переспрашивай):",
		`сумма к обмену: ${dir}; выдача: ${payout}; внесение: ${payment}.`,
		"Сумму и направление повторно не спрашивай. Если поле помечено «—» — спроси кратко только его.",
	].join("\n");
}

/** Строка-сводка для подтверждения (ИДЁТ В ОТВЕТ — формулировки guard-safe). */
function renderExchangeSummaryLine(
	c: ExchangeCollected,
	quoteResult: unknown,
): string | null {
	const row = (quoteResult ?? {}) as Record<string, unknown>;
	const amountToThb = numberLike(row.amountToThb);
	if (amountToThb === null || !c.asset || !c.amount) return null;
	const directionQuote =
		typeof row.direction === "string" ? row.direction.split("->")[1] : null;
	const currency = resolveQuoteCurrency(
		typeof row.quoteAsset === "string" ? row.quoteAsset : directionQuote,
	);
	const net = c.network ? ` (${c.network})` : "";
	const payout = exchangePayoutLabel(c.payoutMethod);
	const payment =
		c.asset === "RUB" ? exchangePaymentLabel(c.paymentMethod) : null;
	const tail = [
		payout ? `выдача — ${payout}` : null,
		payment ? `внесение — ${payment}` : null,
	]
		.filter(Boolean)
		.join(", ");
	return `Итак: меняем ${c.amount} ${c.asset}${net} → получите ${amountToThb} ${currency.code}${tail ? `, ${tail}` : ""}.`;
}

/**
 * Запрос метода оплаты (СБП/карта) — отдельный ход после ответа на способ выдачи.
 * В отдельном ходу числа котировки нет → guard пропускает слова qr/сбп/карта.
 * Гейт через единый buildExchangeCollected: актив=RUB, выдача известна, оплата нет.
 */
function maybeForceExchangePaymentMethodQuestion(
	userMessageText: string,
	history: MessageRow[],
	state: ExchangePolicyState | null,
	injected?: ExchangeCollectedInput | null,
): ExchangeForcedReply | null {
	if (state?.stageSlug !== "quote_calculated") return null;
	// Несерьёзные / длинные сообщения оставляем LLM
	if (userMessageText.trim().length > 300) return null;
	const collected = buildExchangeCollected(injected);
	if (collected.asset !== "RUB") return null; // крипта → crypto_transfer авто
	if (collected.paymentMethod) return null; // уже назван
	if (!collected.payoutMethod) return null; // сперва способ выдачи
	if (isExchangeOrderConfirmation(userMessageText)) return null;
	const alreadyAsked = history
		.slice(-4)
		.some(
			(m) => m.role === "assistant" && m.text.includes("банк-приложении или"),
		);
	if (alreadyAsked) return null;
	return {
		text: "Как удобнее внести рубли — по QR-коду в банк-приложении или банковским переводом со счёта?",
		toolCalls: [],
	};
}

function numberLike(value: unknown): number | null {
	const n =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: NaN;
	return Number.isFinite(n) ? n : null;
}

function forcedExchangeQuoteText(
	result: unknown,
	networkAssumed = false,
	showRate = false,
): string | null {
	if (!result || typeof result !== "object") return null;
	const row = result as Record<string, unknown>;
	if (typeof row.error === "string") return row.error;
	const amountToThb = numberLike(row.amountToThb);
	if (amountToThb === null) return null;
	// Валюта тенанта — из результата инструмента (quoteAsset или хвост direction).
	const directionQuote =
		typeof row.direction === "string" ? row.direction.split("->")[1] : null;
	const currency = resolveQuoteCurrency(
		typeof row.quoteAsset === "string" ? row.quoteAsset : directionQuote,
	);
	// Тёплая формулировка (не сухое «Получите X»). Число/валюта — от compute_quote
	// (guard пропускает). Исходную сумму повторяем, чтобы LLM не «терял» её.
	// Грамматически нейтрально («Готово/получаете»), без гендерных глаголов прош. вр.
	const amountFrom = numberLike(row.amountFrom);
	const srcAsset =
		typeof row.asset === "string"
			? row.asset
			: typeof row.direction === "string"
				? row.direction.split("->")[0]
				: null;
	// Сеть не названа клиентом → курс/комиссия дефолтной сети; помечаем честно,
	// чтобы первая цифра не вводила в заблуждение на ERC20/BEP20.
	const net = typeof row.network === "string" ? row.network.toUpperCase() : null;
	const netNote =
		networkAssumed && net && srcAsset && /USDT|USDC|ETH/iu.test(srcAsset)
			? ` (расчёт по сети ${net}; на других сетях курс и комиссия отличаются)`
			: "";
	// Курс показываем только когда клиент его явно спросил (showRate).
	const rate = numberLike(row.rate);
	const rateNote =
		showRate && rate !== null && srcAsset
			? ` (курс 1 ${srcAsset} = ${rate} ${currency.code})`
			: "";
	return amountFrom !== null && srcAsset
		? `Готово! Отдаёте ${amountFrom} ${srcAsset}${rateNote} — получите ${amountToThb} ${currency.code} на руки${netNote}.`
		: `Готово — получите ${amountToThb} ${currency.code} на руки${netNote}.`;
}

const EXCHANGE_USDT_RE = /usdt|юсдт/iu;

/**
 * Вопрос о недостающих параметрах ПОСЛЕ котировки (см. rag-reply): сеть USDT
 * (если не указана) + способ выдачи. Способ оплаты (СБП/карта) выносим в
 * отдельный шаг (maybeForceExchangePaymentMethodQuestion) — в отдельном ходу
 * нет числа котировки → guard пропускает слова qr/сбп/карта.
 * networkKnown/payoutKnown — поля из buildExchangeCollected (#654), не regex.
 */
function exchangeMissingFieldsQuestion(
	asset: string,
	networkKnown: boolean,
	payoutKnown: boolean,
): string | null {
	const parts: string[] = [];
	if (EXCHANGE_USDT_RE.test(asset) && !networkKnown) {
		parts.push("в какой сети будете отправлять USDT — TRC20, ERC20 или BEP20");
	}
	if (!payoutKnown) {
		parts.push(
			"как удобнее получить деньги — наличными в офисе, снятием в банкомате или зачислением на тайский банковский счёт",
		);
	}
	if (parts.length === 0) return null;
	return `Подскажите, ${parts.join(", и ")}?`;
}

// #723 — антиповтор: бот уже давал котировку в недавней истории (число +
// упоминание валюты выдачи). Тогда «курс устраивает»/повторное «сколько» НЕ
// должны переотправлять ту же котировку — иначе бот зацикливается на
// quote_calculated, игнорируя подтверждение и выбор выдачи.
function hasRecentExchangeQuote(history: MessageRow[]): boolean {
	return history
		.slice(-8)
		.some(
			(item) =>
				item.role === "assistant" &&
				/\d/.test(item.text) &&
				ANY_QUOTE_CURRENCY_MENTION_RE.test(item.text),
		);
}

async function maybeForceExchangeQuoteReply(
	userMessageText: string,
	tools: AnyRagTool[],
	history: MessageRow[],
	injected?: ExchangeCollectedInput | null,
): Promise<ExchangeForcedReply | null> {
	const quoteTool = tools.find(
		(tool) => tool.name === "compute_exchange_quote",
	);
	if (!quoteTool) return null;
	// Аргументы — из универсально собранного (leadFieldValues), не regex (#654).
	const collected = buildExchangeCollected(injected);
	if (!collected.asset || !collected.amount) return null;
	// Котируем, только если клиент назвал СВЕЖУЮ сумму этого хода
	// (amountSetThisTurn) ИЛИ это первый запрос курса (ещё не котировали).
	// После выданной котировки «курс устраивает»/повторное «сколько» НЕ
	// пере-котируем (#723) — отдаём дальше на подтверждение/сводку/LLM.
	const rateAsked = EXCHANGE_RATE_QUESTION_RE.test(userMessageText);
	const freshAmount =
		injected?.amountSetThisTurn === true ||
		(EXCHANGE_QUOTE_INTENT_RE.test(userMessageText) &&
			!hasRecentExchangeQuote(history));
	// Явный вопрос про курс обслуживаем всегда — показываем курс (showRate).
	if (!freshAmount && !rateAsked) return null;
	const args: ExchangeQuoteArgs = {
		asset: collected.asset,
		amount: collected.amount,
		...(collected.network ? { network: collected.network } : {}),
	};
	const result = await quoteTool.execute(args);
	const text = forcedExchangeQuoteText(result, !args.network, rateAsked);
	if (!text) return null;
	const ask = exchangeMissingFieldsQuestion(
		collected.asset,
		Boolean(collected.network),
		Boolean(collected.payoutMethod),
	);
	return {
		text: ask ? `${text}\n\n${ask}` : text,
		toolCalls: [{ name: quoteTool.name, args, result, cycle: 0 }],
	};
}

function forcedExchangeOrderText(result: unknown): string | null {
	if (!result || typeof result !== "object") return null;
	const row = result as Record<string, unknown>;
	if (typeof row.instructions === "string" && row.instructions.trim()) {
		return row.instructions.trim();
	}
	if (typeof row.error === "string" && row.error.trim())
		return row.error.trim();
	if (row.orderId !== undefined) {
		return "Отлично, заявку оформил! 🙌 Секунду — подготовлю следующий шаг.";
	}
	return null;
}

/**
 * Текст реквизитов из результата fetch_exchange_requisites. null —
 * needsOperator/ошибка: реквизиты выдаст оператор, не дописываем их в ответ.
 */
function forcedExchangeRequisitesText(result: unknown): string | null {
	if (!result || typeof result !== "object") return null;
	const row = result as Record<string, unknown>;
	if (row.needsOperator === true) return null;
	if (typeof row.error === "string" && row.error.trim()) return null;
	if (typeof row.instructions === "string" && row.instructions.trim()) {
		return row.instructions.trim();
	}
	return null;
}

/**
 * Аргументы заявки из универсально собранного (leadFieldValues), не regex (#654).
 * paymentMethod добавляем только если собран (в отличие от rag-reply здесь нет
 * дефолта по активу — сохраняем прежнее поведение llm-reply).
 */
function exchangeOrderArgsFromCollected(
	injected?: ExchangeCollectedInput | null,
): ExchangeOrderArgs | null {
	const collected = buildExchangeCollected(injected);
	if (!collected.asset || !collected.amount) return null;
	return {
		asset: collected.asset,
		amount: collected.amount,
		amountMode: "source_amount",
		...(collected.network ? { network: collected.network } : {}),
		...(collected.payoutMethod ? { payoutMethod: collected.payoutMethod } : {}),
		...(collected.paymentMethod
			? { paymentMethod: collected.paymentMethod }
			: {}),
	};
}

async function maybeForceExchangeOrderReply(
	userMessageText: string,
	tools: AnyRagTool[],
	state: ExchangePolicyState | null,
	injected?: ExchangeCollectedInput | null,
): Promise<ExchangeForcedReply | null> {
	if (state?.stageSlug !== "quote_calculated") return null;
	if (!isExchangeOrderConfirmation(userMessageText)) return null;
	const orderTool = tools.find((tool) => tool.name === "create_exchange_order");
	if (!orderTool) return null;
	const args = exchangeOrderArgsFromCollected(injected);
	if (!args) return null;
	const result = await orderTool.execute(args);
	const text = forcedExchangeOrderText(result);
	if (!text) return null;
	const toolCalls: ToolCallRecord[] = [
		{ name: orderTool.name, args, result, cycle: 0 },
	];
	// Заявка создана успешно — сразу тянем реквизиты, чтобы выдать их в том же
	// сообщении: иначе клиент ждёт «сейчас подготовлю», а заявка протухает по TTL.
	// needsOperator/ошибка реквизитов — оставляем исходный текст (выдаст оператор).
	const orderRow = result as Record<string, unknown> | null;
	if (
		orderRow &&
		typeof orderRow.orderId === "number" &&
		orderRow.needsVerification !== true
	) {
		const fetchTool = tools.find(
			(tool) => tool.name === "fetch_exchange_requisites",
		);
		if (fetchTool) {
			try {
				const reqResult = await fetchTool.execute({});
				toolCalls.push({
					name: fetchTool.name,
					args: {},
					result: reqResult,
					cycle: 1,
				});
				const reqText = forcedExchangeRequisitesText(reqResult);
				if (reqText)
					return {
						text: `Отлично, заявку оформил! 🙌 Вот реквизиты для оплаты:\n\n${reqText}`,
						toolCalls,
					};
			} catch (err) {
				console.warn("[llm-reply] forced requisites fetch failed:", err);
			}
		}
	}
	return { text, toolCalls };
}

const EXCHANGE_SUMMARY_MARKER = "Оформляю заявку?";

/**
 * Сводку «Оформляю заявку?» показываем один раз за эпизод заявки: сканируем
 * историю назад до границы эпизода (заявка оформлена / выданы реквизиты). Раньше
 * было окно slice(-4) — пара уточняющих Q&A выталкивала сводку из окна → дубль
 * (#653). Окно истории ограничено (~historyLimit, дефолт 20), скан дёшев.
 */
function exchangeSummaryAlreadyShown(
	history: Array<Pick<MessageRow, "role" | "text">>,
): boolean {
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i];
		if (!m) continue;
		if (m.role !== "assistant" && m.role !== "human") continue;
		// Граница нового эпизода: заявка уже оформлялась / выдавались реквизиты —
		// дальше назад не смотрим, новую сводку показать можно.
		if (/заявку оформил|реквизиты для оплаты/iu.test(m.text)) return false;
		if (m.text.includes(EXCHANGE_SUMMARY_MARKER)) return true;
	}
	return false;
}

/**
 * Сводка + «Оформляю заявку?» когда ВСЕ обязательные поля собраны, но клиент ещё
 * не подтвердил. Закрывает тупик: раньше после «на счёт, сбер» управление уходило
 * в LLM (→ «уточните сумму»). Число — от повторного compute_exchange_quote.
 */
async function maybeForceExchangeSummaryConfirm(
	userMessageText: string,
	history: MessageRow[],
	tools: AnyRagTool[],
	state: ExchangePolicyState | null,
	injected?: ExchangeCollectedInput | null,
): Promise<ExchangeForcedReply | null> {
	if (state?.stageSlug !== "quote_calculated") return null;
	if (userMessageText.trim().length > 300) return null;
	// «да»/«ок» → дальше создаём заявку (maybeForceExchangeOrderReply), не сводку.
	if (isExchangeOrderConfirmation(userMessageText)) return null;
	if (EXCHANGE_KYC_MATERIAL_SENT_RE.test(userMessageText)) return null;
	const collected = buildExchangeCollected(injected);
	if (collected.missing.length > 0) return null;
	if (!collected.asset || !collected.amount) return null;
	if (exchangeSummaryAlreadyShown(history)) return null;
	const quoteTool = tools.find(
		(tool) => tool.name === "compute_exchange_quote",
	);
	if (!quoteTool) return null;
	const quoteArgs: ExchangeOrderArgs = {
		asset: collected.asset,
		amount: collected.amount,
		amountMode: "source_amount",
		...(collected.network ? { network: collected.network } : {}),
	};
	const result = await quoteTool.execute(quoteArgs);
	const summary = renderExchangeSummaryLine(collected, result);
	if (!summary) return null;
	return {
		text: `${summary}\n\n${EXCHANGE_SUMMARY_MARKER}`,
		toolCalls: [{ name: quoteTool.name, args: quoteArgs, result, cycle: 0 }],
	};
}

function maybeForceExchangeKycReply(
	userMessageText: string,
	currency: QuoteCurrency,
): ExchangeForcedReply | null {
	if (!EXCHANGE_KYC_TOPIC_RE.test(userMessageText)) return null;
	if (EXCHANGE_KYC_MATERIAL_SENT_RE.test(userMessageText)) return null;
	return { text: buildExchangeKycHandoffText(currency), toolCalls: [] };
}

// Числа сетей (TRC20/ERC20/BEP20) — буква перед «20» → не парсятся как сумма
// (NUMBER_RE требует не-буквы слева); слов оплат/перев/реквизит нет → guard ок.
const EXCHANGE_SUPPORTED_NETWORKS_REPLY =
	"Эту сеть, к сожалению, не поддерживаем. Доступны TRC20, ERC20 и BEP20 — в какой из них вам удобно отправить?";

// Интент-классификатор поддерживаемой сети (#654: КЛАССИФИКАТОР, не сбор полей).
// Копия паттерна rag-reply.ts (единый источник истины о поддерживаемых сетях):
// исключает форс-ответ про неподдерживаемую сеть, когда клиент упомянул TRC20/
// ERC20/BEP20/Tron/BSC. Сбор поля network идёт ТОЛЬКО из injected (exchangeCollected).
const EXCHANGE_SUPPORTED_NETWORK_RE =
	/trc[\s-]?20|tron|erc[\s-]?20|bep[\s-]?20|\bbsc\b/iu;

// Сети, про которые часто спрашивают, но мы их НЕ принимаем (поддерживаем только
// TRC20/ERC20/BEP20). Latin \b ненадёжен для кириллицы → lookaround.
const EXCHANGE_UNSUPPORTED_NETWORK_RE =
	/(?<![a-zа-яё])(?:ton|тон|solana|солана|polygon|полигон|matic|матик|avalanche|avax|arbitrum|арбитрум|optimism)(?![a-zа-яё])/iu;

/**
 * Клиент спрашивает про неподдерживаемую сеть (TON/Solana/Polygon/…). Сразу
 * называем доступные сети, без перегенерации и эскалации — иначе бот молотит 3
 * попытки и уходит к оператору на простой вопрос. Если в сообщении упомянута И
 * поддерживаемая сеть — пропускаем (её обработает обычный поток).
 */
function maybeForceExchangeUnsupportedNetworkReply(
	userMessageText: string,
): ExchangeForcedReply | null {
	if (!EXCHANGE_UNSUPPORTED_NETWORK_RE.test(userMessageText)) return null;
	// Интент-классификатор (не сбор поля): упомянута поддерживаемая сеть →
	// отдаём обычному потоку, форс-ответ про неподдерживаемую сеть не шлём.
	if (EXCHANGE_SUPPORTED_NETWORK_RE.test(userMessageText)) return null;
	return { text: EXCHANGE_SUPPORTED_NETWORKS_REPLY, toolCalls: [] };
}

// Явная просьба отменить заявку. «отмен…»/«аннул…»/«убери|сними заявку».
// \w под /u НЕ матчит кириллицу → продолжение слова через [а-яёa-z]*.
const EXCHANGE_CANCEL_INTENT_RE =
	/(?<![a-zа-яё])(?:отмен[а-яёa-z]*|аннул[а-яёa-z]*)(?![a-zа-яё])|(?:убери|сними|удали)\s+заявк/iu;

function forcedExchangeCancelText(result: unknown): string | null {
	const row = (result ?? {}) as Record<string, unknown>;
	if (row.needsOperator === true) {
		return "По заявке уже поступила оплата — передаю оператору, он подтвердит отмену.";
	}
	const cancelled = Array.isArray(row.cancelled) ? row.cancelled : [];
	if (cancelled.length === 0) {
		return "Сейчас активных заявок нет. Если хотите оформить обмен — назовите сумму и направление.";
	}
	return "Заявку отменил. Если хотите оформить заново — назовите сумму и направление, пересчитаю по актуальному курсу.";
}

/**
 * Явная отмена заявки клиентом («отмени заявку»). Детерминированно зовёт
 * cancel_exchange_order (отменяет до-оплатные заявки беседы; с поступившей оплатой
 * → оператор) — иначе LLM «отмену» не исполняет надёжно. Для смены суммы НЕ
 * годится (это перекотировка), поэтому интент узкий: отмен/аннул/убери-сними-заявку.
 */
async function maybeForceExchangeCancelReply(
	userMessageText: string,
	tools: AnyRagTool[],
): Promise<ExchangeForcedReply | null> {
	if (userMessageText.trim().length > 200) return null;
	if (!EXCHANGE_CANCEL_INTENT_RE.test(userMessageText)) return null;
	const cancelTool = tools.find((tool) => tool.name === "cancel_exchange_order");
	if (!cancelTool) return null;
	const result = await cancelTool.execute({});
	const text = forcedExchangeCancelText(result);
	if (!text) return null;
	return {
		text,
		toolCalls: [{ name: cancelTool.name, args: {}, result, cycle: 0 }],
	};
}

export class LlmReplyStrategy implements ReplyStrategy {
	constructor(
		private readonly opts: LlmReplyStrategyOpts,
		private readonly messagesRepoFor: (tenantId: number) => MessagesRepo,
		private readonly conversationsRepoFor?: (
			tenantId: number,
		) => ConversationsRepo,
	) {}

	async generate(input: {
		tenant: { tenantId: number };
		channel: { channelId: number };
		conversationId: number;
		contactId: number;
		inbound: { externalUserId: string };
		userMessageText: string;
		userMessageId?: number;
	}): Promise<ReplyStrategyResult> {
		if (input.userMessageText.length === 0) return null;
		const tenantId = input.tenant.tenantId;
		const template =
			this.opts.resolveTemplate?.(tenantId) ?? this.opts.template;

		if (this.opts.resolveIsSupport) {
			const isSupport = await this.opts.resolveIsSupport({
				tenantId,
				contactId: input.contactId,
			});
			if (isSupport) return null;
		}

		const chat = this.opts.resolveChat(tenantId);
		const messages = this.messagesRepoFor(tenantId);
		let recentWindow = this.opts.historyLimit ?? 20;
		if (this.opts.resolveHistoryLimit) {
			try {
				const v = await this.opts.resolveHistoryLimit({ tenantId });
				if (typeof v === "number" && Number.isFinite(v) && v >= 2)
					recentWindow = v;
			} catch (err) {
				console.warn("[llm-reply] failed to resolve history limit:", err);
			}
		}
		// #623 — per-tenant override параметров генерации.
		let genTemperature = this.opts.temperature ?? 0.7;
		let genMaxTokens = this.opts.maxOutputTokens ?? 600;
		let genCompactAfter = this.opts.compactAfterMessages ?? 20;
		if (this.opts.resolveGenerationParams) {
			try {
				const g = await this.opts.resolveGenerationParams({ tenantId });
				if (g) {
					if (
						typeof g.temperature === "number" &&
						Number.isFinite(g.temperature)
					)
						genTemperature = g.temperature;
					if (typeof g.maxOutputTokens === "number" && g.maxOutputTokens > 0)
						genMaxTokens = g.maxOutputTokens;
					if (
						typeof g.compactAfterMessages === "number" &&
						g.compactAfterMessages > 0
					)
						genCompactAfter = g.compactAfterMessages;
				}
			} catch (err) {
				console.warn("[llm-reply] failed to resolve generation params:", err);
			}
		}
		const { history, conversationSummary } =
			await loadRollingConversationContext({
				conversationId: input.conversationId,
				messages,
				conversations: this.conversationsRepoFor?.(tenantId) ?? null,
				chat,
				options: {
					recentWindow,
					summarizeAfterMessages: genCompactAfter,
					summaryMaxChars: this.opts.summaryMaxChars ?? 600,
				},
				onWarn: (_message, err) => {
					console.warn("[llm-reply] conversation summary failed:", err);
				},
			});
		const historyMessages = messageRowsToChatHistory(history);
		const llmOpts = {
			temperature: genTemperature,
			numPredict: genMaxTokens,
		};

		// Agentic-инструменты (если есть и клиент их умеет): даёт боту считать
		// курс/сумму tool-call'ом вместо «уточню у партнёра», даже без RAG.
		let tools: AnyRagTool[] = [];
		if (this.opts.resolveTools) {
			try {
				tools = await this.opts.resolveTools({
					tenantId,
					conversationId: input.conversationId,
					contactId: input.contactId,
				});
			} catch {
				tools = [];
			}
		}
		const toolsActive =
			tools.length > 0 && typeof chat.completeWithTools === "function";
		const serviceOrderContext = this.opts.resolveServiceOrderContext
			? await Promise.resolve(
					this.opts.resolveServiceOrderContext({
						tenantId,
						conversationId: input.conversationId,
						contactId: input.contactId,
					}),
				)
			: null;

		const isExchange = template.slug === "exchange_v1";
		const exchangePolicyState =
			isExchange && this.opts.resolveExchangePolicyState
				? await Promise.resolve(
						this.opts.resolveExchangePolicyState({
							tenantId,
							conversationId: input.conversationId,
							contactId: input.contactId,
						}),
					).catch((err) => {
						console.warn(
							"[llm-reply] failed to resolve exchange policy state:",
							err,
						);
						return null;
					})
				: null;
		const exchangeCollected =
			isExchange && this.opts.resolveExchangeCollected
				? await Promise.resolve(
						this.opts.resolveExchangeCollected({
							tenantId,
							conversationId: input.conversationId,
							contactId: input.contactId,
						}),
					).catch((err) => {
						console.warn(
							"[llm-reply] failed to resolve exchange collected fields:",
							err,
						);
						return null;
					})
				: null;
		const exchangeQuoteCurrency =
			(isExchange && this.opts.resolveExchangeQuoteCurrency
				? await Promise.resolve(
						this.opts.resolveExchangeQuoteCurrency({
							tenantId,
							conversationId: input.conversationId,
							contactId: input.contactId,
						}),
					).catch(() => null)
				: null) ?? QUOTE_CURRENCY;
		const forcedExchangeReply = isExchange
			? (maybeForceExchangeUnsupportedNetworkReply(input.userMessageText) ??
				(await maybeForceExchangeCancelReply(input.userMessageText, tools)) ??
				(await maybeForceExchangeOrderReply(
					input.userMessageText,
					tools,
					exchangePolicyState,
					exchangeCollected,
				)) ??
				(await maybeForceExchangeQuoteReply(
					input.userMessageText,
					tools,
					history,
					exchangeCollected,
				)) ??
				maybeForceExchangePaymentMethodQuestion(
					input.userMessageText,
					history,
					exchangePolicyState,
					exchangeCollected,
				) ??
				(await maybeForceExchangeSummaryConfirm(
					input.userMessageText,
					history,
					tools,
					exchangePolicyState,
					exchangeCollected,
				)) ??
				maybeForceExchangeKycReply(input.userMessageText, exchangeQuoteCurrency))
			: null;
		const exchangeGuardEnabled =
			isExchange && this.opts.resolveExchangeResponseGuardEnabled
				? await Promise.resolve(
						this.opts.resolveExchangeResponseGuardEnabled({
							tenantId,
							conversationId: input.conversationId,
							contactId: input.contactId,
						}),
					).catch((err) => {
						console.warn(
							"[llm-reply] failed to resolve exchange response guard flag:",
							err,
						);
						return true;
					})
				: true;
		const exchangeCustomerNoticeEnabled =
			isExchange && this.opts.resolveExchangeCustomerNoticeEnabled
				? await Promise.resolve(
						this.opts.resolveExchangeCustomerNoticeEnabled({
							tenantId,
							conversationId: input.conversationId,
							contactId: input.contactId,
						}),
					).catch((err) => {
						console.warn(
							"[llm-reply] failed to resolve exchange handoff notice setting:",
							err,
						);
						return true;
					})
				: true;

		if (forcedExchangeReply) {
			const telemetry = buildToolTelemetry(forcedExchangeReply.toolCalls);
			const guarded = exchangeGuardEnabled
				? guardExchangePolicy({
						text: forcedExchangeReply.text,
						telemetry,
						history,
						state: exchangePolicyState,
					})
				: {
						ok: true,
						action: "pass" as const,
						text: forcedExchangeReply.text,
						reasons: [],
						requiredFixes: [],
					};
			const guardFinding = exchangeGuardEnabled
				? exchangeGuardFindingFromResult(guarded)
				: null;
			if (
				this.opts.recordToolCalls &&
				(forcedExchangeReply.toolCalls.length > 0 || guardFinding)
			) {
				try {
					await this.opts.recordToolCalls({
						tenantId,
						conversationId: input.conversationId,
						contactId: input.contactId,
						userMessageText: input.userMessageText,
						assistantText: guarded.text,
						toolCalls: forcedExchangeReply.toolCalls,
						...(guardFinding ? { guardFindings: [guardFinding] } : {}),
					});
				} catch (err) {
					console.warn(
						"[llm-reply] failed to record forced exchange tool call:",
						err,
					);
				}
			}
			// Форс-ответ детерминирован и подкреплён тулами — без перегенерации.
			const operatorHandoff = resolveExchangeOperatorHandoff({
				text: guarded.text,
				action: guarded.action,
				reason: guarded.reason ?? null,
				telemetry,
				state: exchangePolicyState,
				retriesExhausted: false,
			});
			return exchangeReplyOutput({
				channelId: input.channel.channelId,
				externalUserId: input.inbound.externalUserId,
				text: guarded.text,
				operatorHandoff,
				customerNoticeEnabled: exchangeCustomerNoticeEnabled,
			});
		}

		// Грунтинг exchange-состояния: что клиент уже назвал (сумма/направление/
		// выдача/оплата). Идёт в промпт — LLM не теряет сумму и не переспрашивает.
		const exchangeGrounding = isExchange
			? renderExchangeCollectedGrounding(buildExchangeCollected(exchangeCollected))
			: null;
		const systemPrompt = [
			LLM_REPLY_BASE_SYSTEM_PROMPT,
			toolsActive ? LLM_REPLY_TOOLS_SYSTEM_FRAGMENT : "",
			serviceOrderContext?.trim(),
			exchangeGrounding,
			renderConversationSummaryBlock(conversationSummary),
			template.systemPromptFragment,
		]
			.filter(Boolean)
			.join("\n\n");

		const msgs: ChatMessage[] = [
			{ role: "system", content: systemPrompt },
			...historyMessages,
		];

		// Генерация ответа. Для exchange — цикл «перегенерировать, пока не нормальный
		// ответ» (выбор владельца): если гард заблокировал выдуманный курс/реквизиты
		// ЛИБО бот сам ушёл в отписку «уточню у оператора» — НЕ отправляем это, а
		// молча перегенерируем с корректирующей подсказкой, до
		// MAX_EXCHANGE_REPLY_ATTEMPTS попыток. Все попытки мимо → передаём оператору
		// (эскалация по СЧЁТЧИКУ неудач, не по тексту). Жёсткие политические блоки
		// (escalate/block: KYC/оплата/выдача) НЕ ретраим — сразу оператор. Не-exchange
		// или выключенный guard — одна генерация, как раньше.
		const maxAttempts =
			isExchange && exchangeGuardEnabled ? MAX_EXCHANGE_REPLY_ATTEMPTS : 1;
		let reply = "";
		let toolCalls: ToolCallRecord[] = [];
		let guarded: ReturnType<typeof guardExchangePolicy> = {
			ok: true,
			action: "pass",
			text: "",
			reasons: [],
			requiredFixes: [],
		};
		let correctiveHint: string | null = null;
		let retriesExhausted = false;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const attemptMsgs = correctiveHint
				? [...msgs, { role: "system" as const, content: correctiveHint }]
				: msgs;
			if (toolsActive) {
				const loop = await runToolLoop({
					chat,
					messages: attemptMsgs,
					tools,
					llmOpts,
					maxCycles: DEFAULT_MAX_TOOL_CYCLES,
				});
				toolCalls = loop.toolCalls;
				// loop.content — финальный текст; если null (исчерпал циклы) — добиваем
				// обычным complete по messages с уже вложенными tool-результатами.
				reply = loop.content ?? (await chat.complete(attemptMsgs, llmOpts));
			} else {
				reply = await chat.complete(attemptMsgs, llmOpts);
				toolCalls = [];
			}
			guarded =
				isExchange && exchangeGuardEnabled
					? guardExchangePolicy({
							text: reply,
							telemetry: buildToolTelemetry(toolCalls),
							history,
							state: exchangePolicyState,
						})
					: { ok: true, action: "pass", text: reply, reasons: [], requiredFixes: [] };
			if (maxAttempts === 1 || reply.trim().length === 0) break;
			// Жёсткий политический блок — сразу оператор, без перегенерации.
			if (guarded.action === "escalate" || guarded.action === "block") break;
			// «Плохой ответ» = гард переписал (выдуманный курс/реквизиты/торг) ЛИБО бот
			// сам выдал отписку «уточню у оператора». Иначе — нормальный ответ, отдаём.
			const badAnswer =
				!guarded.ok || guarded.text.trim() === EXCHANGE_SAFE_FALLBACK;
			if (!badAnswer) break;
			if (attempt >= maxAttempts) {
				retriesExhausted = true;
				break;
			}
			correctiveHint = buildExchangeRetryHint(guarded);
		}

		if (reply.trim().length === 0) return null;
		const guardFinding =
			isExchange && exchangeGuardEnabled
				? exchangeGuardFindingFromResult(guarded)
				: null;
		if (!guarded.ok) {
			console.warn(
				`[exchange-policy-guard] tenant=${tenantId} conversation=${input.conversationId} reason=${guarded.reason ?? "unknown"}`,
			);
		}
		if (this.opts.recordToolCalls && (toolCalls.length > 0 || guardFinding)) {
			try {
				await this.opts.recordToolCalls({
					tenantId,
					conversationId: input.conversationId,
					contactId: input.contactId,
					userMessageText: input.userMessageText,
					assistantText: guarded.text,
					toolCalls,
					...(guardFinding ? { guardFindings: [guardFinding] } : {}),
				});
			} catch (err) {
				console.warn("[llm-reply] failed to record tool calls:", err);
			}
		}
		const operatorHandoff = isExchange
			? resolveExchangeOperatorHandoff({
					text: guarded.text,
					action: guarded.action,
					reason: guarded.reason ?? null,
					telemetry: buildToolTelemetry(toolCalls),
					state: exchangePolicyState,
					retriesExhausted,
				})
			: null;
		return isExchange
			? exchangeReplyOutput({
					channelId: input.channel.channelId,
					externalUserId: input.inbound.externalUserId,
					text: guarded.text,
					operatorHandoff,
					customerNoticeEnabled: exchangeCustomerNoticeEnabled,
				})
			: [
					{
						channelId: String(input.channel.channelId),
						externalUserId: input.inbound.externalUserId,
						parts: [{ kind: "text", text: guarded.text }],
					},
				];
	}
}
