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
	rewriteUnbackedQuoteReply,
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

type AmountCandidate = {
	amount: number;
	start: number;
	score: number;
};

type ExchangeForcedReply = {
	text: string;
	toolCalls: ToolCallRecord[];
};

const EXCHANGE_QUOTE_INTENT_RE =
	/курс|rate|сколько|получ(?:у|ится|ить)|итого|посчитай|рассчитай/i;
// Любая известная котируемая валюта: тенанты на одном деплое могут работать
// в разных валютах (per-tenant настройка), guard ловит все.
const EXCHANGE_OUTPUT_CURRENCY_RE = ANY_QUOTE_CURRENCY_MENTION_RE;
const EXCHANGE_CONFIRMATION_RE = /точно|верно|правильно/i;
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
const EXCHANGE_KYC_HANDOFF_TEXT = [
	"Да. Перед реквизитами нужна верификация клиента.",
	"Пришлите короткое видео: лицо и документ в кадре. Оператор или внешний сервис проведёт проверку личности.",
	`После проверки продолжим заявку: способ получения ${QUOTE_CURRENCY.wordGen}, реквизиты и финальное подтверждение.`,
].join("\n");

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

/**
 * Кому-то нужен оператор? Порядок резолва хэндоффа для exchange-ответа:
 *   1) сигнал из tool-результата/состояния (buildExchangeOperatorHandoff);
 *   2) guard потребовал escalate/block — явный generic с причиной guard'а;
 *   3) финальный текст клиенту = safe-fallback «уточню у оператора».
 *      Бот ПООБЕЩАЛ клиенту оператора, но конкретики дать не смог: вопрос вне
 *      сценария («а через TON сеть нельзя?»), провал перезапроса unbacked_quote,
 *      торг по курсу и т.п. Без этой ветки обещание повисает: лид не помечается
 *      escalated, оператор не уведомлён, бот сам «вернуться» не может.
 */
function resolveExchangeOperatorHandoff(input: {
	text: string;
	action: ExchangeResponseGuardAction;
	reason: string | null;
	telemetry: Parameters<typeof buildExchangeOperatorHandoff>[0]["telemetry"];
	state: ExchangePolicyState | null;
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
	if (input.text.trim() === EXCHANGE_SAFE_FALLBACK) {
		return buildExchangeGenericOperatorHandoff({
			state: input.state,
			context: input.reason ?? "deferred_to_operator",
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

function assetMentionRe(asset: string): RegExp {
	switch (asset) {
		case "USDT":
			return /\busdt\b|юсдт/i;
		case "BTC":
			return /\bbtc\b|битк/i;
		case "ETH":
			return /\beth\b|эфир/i;
		case "RUB":
			return /\brub\b|руб|₽/i;
		case "EUR":
			return /\beur\b|евро/i;
		case "USD":
			return /\busd\b|доллар|бакс/i;
		default:
			return new RegExp(`\\b${asset}\\b`, "i");
	}
}

/**
 * Парсинг суммы с разделителями тысяч: «20.000» / «1.500.000» / «20,000» →
 * целое (точка/запятая как группировка по 3 цифры), иначе запятая = десятичная.
 * Без этого Number("20.000") = 20 → «20.000 руб» парсилось как 20 RUB.
 */
function parseExchangeAmountToken(raw: string): number {
	const s = raw.replace(/\s/g, "");
	if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ""));
	return Number(s.replace(",", "."));
}

function amountCandidates(text: string, asset: string): AmountCandidate[] {
	const assetRe = assetMentionRe(asset);
	const matches = [
		...text.matchAll(/\d+(?:[ \u00a0]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g),
	];
	const candidates: AmountCandidate[] = [];
	for (const match of matches) {
		const raw = match[0];
		const start = match.index ?? 0;
		const end = start + raw.length;
		const before = text.slice(Math.max(0, start - 16), start).toLowerCase();
		if (/trc\s*$|erc\s*$|bep\s*$/i.test(before)) continue;
		const after = text.slice(end, end + 16).toLowerCase();
		const n = parseExchangeAmountToken(raw);
		if (!Number.isFinite(n) || n <= 0) continue;

		let score = 0;
		const afterTrimmed = after.trimStart();
		// «тыс»/«к»/«k» — множитель тысяч ТОЛЬКО как суффикс сразу после числа
		// (иначе слово вроде «тысяч»/обрезанное «к» в окне даёт ложный ×1000).
		const multiplier =
			/^тыс/i.test(afterTrimmed) || /^[кk](?:\b|\s|$)/iu.test(afterTrimmed)
				? 1000
				: 1;
		const window = `${before}${raw}${after}`;
		if (assetRe.test(window)) score += 5;
		if (/(?:^|\s)за\s*$/iu.test(before) || /\bза\b/iu.test(before)) score += 2;
		if (
			EXCHANGE_OUTPUT_CURRENCY_RE.test(after) &&
			asset !== QUOTE_CURRENCY.code
		)
			score -= 4;
		candidates.push({ amount: n * multiplier, start, score });
	}
	return candidates;
}

function hasExchangeStartIntent(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("обмен") ||
		lower.includes("помен") ||
		lower.includes("меняю") ||
		lower.includes("отдаю") ||
		lower.includes("нужн")
	);
}

function parseExchangeQuoteArgs(text: string): ExchangeQuoteArgs | null {
	const quoteIntent = EXCHANGE_QUOTE_INTENT_RE.test(text);
	const confirmationIntent =
		EXCHANGE_CONFIRMATION_RE.test(text) &&
		EXCHANGE_OUTPUT_CURRENCY_RE.test(text);
	const strongIntent = quoteIntent || confirmationIntent;
	if (!strongIntent && !hasExchangeStartIntent(text)) return null;
	if (EXCHANGE_KYC_TOPIC_RE.test(text) && !strongIntent) return null;
	if (
		EXCHANGE_KYC_TOPIC_RE.test(text) &&
		!confirmationIntent &&
		!EXCHANGE_OUTPUT_CURRENCY_RE.test(text)
	) {
		return null;
	}
	const lower = text.toLowerCase();
	const asset = /\busdt\b|юсдт/.test(lower)
		? "USDT"
		: /\bbtc\b|битк/.test(lower)
			? "BTC"
			: /\beth\b|эфир/.test(lower)
				? "ETH"
				: /\brub\b|руб|₽/.test(lower)
					? "RUB"
					: /\beur\b|евро/.test(lower)
						? "EUR"
						: /\busd\b|доллар|бакс/.test(lower)
							? "USD"
							: null;
	if (!asset) return null;

	const candidates = amountCandidates(text, asset);
	const best = candidates.sort(
		(a, b) => b.score - a.score || a.start - b.start,
	)[0];
	if (!best) return null;

	const network = parseNetwork(text);
	return { asset, amount: best.amount, ...(network ? { network } : {}) };
}

/** Сеть USDT из текста (TRC20/ERC20/BEP20) или undefined. */
function parseNetwork(text: string): string | undefined {
	return /trc[\s-]?20|tron/i.test(text)
		? "TRC20"
		: /erc[\s-]?20/i.test(text)
			? "ERC20"
			: /bep[\s-]?20|bsc/i.test(text)
				? "BEP20"
				: undefined;
}

function parsePayoutMethod(text: string): string | undefined {
	if (/банкомат|atm/i.test(text)) return "atm";
	if (/офис/i.test(text)) return "office_cash";
	if (/наличны/i.test(text)) return "office_cash";
	if (/курьер/i.test(text)) return "courier_cash";
	if (
		/тайск\w*\s*банк|thai\s*bank|bangkok|kbank|scb|зачисл|банк(?:овск)?\w*\s+сч[её]т/i.test(
			text,
		)
	)
		return "thai_bank_transfer";
	return undefined;
}

function recentExchangeOrderArgs(
	userMessageText: string,
	history: MessageRow[],
): ExchangeOrderArgs | null {
	const texts = [
		userMessageText,
		...history
			.filter((message) => message.role === "user")
			.map((message) => message.text)
			.reverse(),
	];
	let payoutMethod: string | undefined;
	let detectedPaymentMethod: string | null = null;
	for (const text of texts) {
		payoutMethod ??= parsePayoutMethod(text);
		detectedPaymentMethod ??= parsePaymentMethod(text);
		const quoteArgs = parseExchangeQuoteArgs(text);
		if (quoteArgs) {
			return {
				...quoteArgs,
				amountMode: "source_amount",
				...(payoutMethod ? { payoutMethod } : {}),
				...(detectedPaymentMethod
					? { paymentMethod: detectedPaymentMethod }
					: {}),
			};
		}
	}
	return null;
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
}

function buildExchangeCollected(
	userMessageText: string,
	history: MessageRow[],
	injected?: ExchangeCollectedInput | null,
): ExchangeCollected {
	// Универсально собранное (ctx из leadFieldValues) — ПРИОРИТЕТ; regex — fallback.
	const userTexts = [
		userMessageText,
		...history
			.filter((m) => m.role === "user")
			.map((m) => m.text)
			.reverse(),
	];
	let base: ExchangeOrderArgs | null = null;
	for (const t of userTexts) {
		const parsed = parseExchangeQuoteArgs(t);
		if (parsed) {
			base = { ...parsed, amountMode: "source_amount" };
			break;
		}
	}
	const injAsset = injected?.asset ? injected.asset.toUpperCase() : null;
	const injNetwork = injected?.network ? injected.network.toUpperCase() : null;
	const asset = injAsset ?? base?.asset ?? null;
	const amount = injected?.amount ?? base?.amount ?? null;
	const network =
		injNetwork ?? base?.network ?? userTexts.map(parseNetwork).find(Boolean) ?? null;
	const payoutMethod =
		injected?.payoutMethod ?? userTexts.map(parsePayoutMethod).find(Boolean) ?? null;
	const paymentMethod =
		injected?.paymentMethod ?? userTexts.map(parsePaymentMethod).find(Boolean) ?? null;
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
	const collected = buildExchangeCollected(userMessageText, history, injected);
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

function forcedExchangeQuoteText(result: unknown): string | null {
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
	const amountFrom = numberLike(row.amountFrom);
	const srcAsset =
		typeof row.asset === "string"
			? row.asset
			: typeof row.direction === "string"
				? row.direction.split("->")[0]
				: null;
	return amountFrom !== null && srcAsset
		? `Посчитал! Отдаёте ${amountFrom} ${srcAsset} — получите ${amountToThb} ${currency.code} на руки.`
		: `Посчитал — получите ${amountToThb} ${currency.code} на руки.`;
}

const EXCHANGE_PAYOUT_KNOWN_RE =
	/банкомат|atm|офис|наличны|курьер|тайск|bangkok|kbank|scb|зачисл/iu;
const EXCHANGE_USDT_RE = /usdt|юсдт/iu;
const EXCHANGE_PAYMENT_SBP_RE =
	/\bqr\b|сбп|sbp|через\s+(?:банк-?)?приложен|мобильн\w*\s*банк/iu;
const EXCHANGE_PAYMENT_CARD_RE =
	/картой|на\s+карт|по\s+карт|\bcard\b|перевод\w*|\bсбер\b|сбербанк|тинькоф\w*|t-?bank|\bальфа\b|райфф\w*|\bвтб\b|газпромбанк|на\s+сч[её]т|со\s+сч[её]т|банковск\w*/iu;

function parsePaymentMethod(text: string): string | null {
	if (EXCHANGE_PAYMENT_SBP_RE.test(text)) return "sbp_qr";
	if (EXCHANGE_PAYMENT_CARD_RE.test(text)) return "card_transfer";
	return null;
}

/**
 * Вопрос о недостающих параметрах ПОСЛЕ котировки (см. rag-reply): сеть USDT
 * (если не указана) + способ выдачи. Способ оплаты (СБП/карта) выносим в
 * отдельный шаг (maybeForceExchangePaymentMethodQuestion) — в отдельном ходу
 * нет числа котировки → guard пропускает слова qr/сбп/карта.
 */
function exchangeMissingFieldsQuestion(
	userText: string,
	asset: string,
	networkKnown: boolean,
): string | null {
	const parts: string[] = [];
	if (EXCHANGE_USDT_RE.test(asset) && !networkKnown) {
		parts.push("в какой сети будете отправлять USDT — TRC20, ERC20 или BEP20");
	}
	if (!EXCHANGE_PAYOUT_KNOWN_RE.test(userText)) {
		parts.push(
			"как удобнее получить деньги — наличными в офисе, снятием в банкомате или зачислением на тайский банковский счёт",
		);
	}
	if (parts.length === 0) return null;
	return `Подскажите, ${parts.join(", и ")}?`;
}

async function maybeForceExchangeQuoteReply(
	userMessageText: string,
	tools: AnyRagTool[],
): Promise<ExchangeForcedReply | null> {
	const quoteTool = tools.find(
		(tool) => tool.name === "compute_exchange_quote",
	);
	if (!quoteTool) return null;
	const args = parseExchangeQuoteArgs(userMessageText);
	if (!args) return null;
	const result = await quoteTool.execute(args);
	const text = forcedExchangeQuoteText(result);
	if (!text) return null;
	const ask = exchangeMissingFieldsQuestion(
		userMessageText,
		args.asset,
		Boolean(args.network),
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

async function maybeForceExchangeOrderReply(
	userMessageText: string,
	history: MessageRow[],
	tools: AnyRagTool[],
	state: ExchangePolicyState | null,
): Promise<ExchangeForcedReply | null> {
	if (state?.stageSlug !== "quote_calculated") return null;
	if (!isExchangeOrderConfirmation(userMessageText)) return null;
	const orderTool = tools.find((tool) => tool.name === "create_exchange_order");
	if (!orderTool) return null;
	const args = recentExchangeOrderArgs(userMessageText, history);
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
	const collected = buildExchangeCollected(userMessageText, history, injected);
	if (collected.missing.length > 0) return null;
	if (!collected.asset || !collected.amount) return null;
	const alreadyShown = history
		.slice(-4)
		.some((m) => m.role === "assistant" && m.text.includes("Оформляю заявку?"));
	if (alreadyShown) return null;
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
		text: `${summary}\n\nОформляю заявку?`,
		toolCalls: [{ name: quoteTool.name, args: quoteArgs, result, cycle: 0 }],
	};
}

function maybeForceExchangeKycReply(
	userMessageText: string,
): ExchangeForcedReply | null {
	if (!EXCHANGE_KYC_TOPIC_RE.test(userMessageText)) return null;
	if (EXCHANGE_KYC_MATERIAL_SENT_RE.test(userMessageText)) return null;
	return { text: EXCHANGE_KYC_HANDOFF_TEXT, toolCalls: [] };
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
		const forcedExchangeReply = isExchange
			? ((await maybeForceExchangeOrderReply(
					input.userMessageText,
					history,
					tools,
					exchangePolicyState,
				)) ??
				(await maybeForceExchangeQuoteReply(input.userMessageText, tools)) ??
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
				maybeForceExchangeKycReply(input.userMessageText))
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
			const operatorHandoff = resolveExchangeOperatorHandoff({
				text: guarded.text,
				action: guarded.action,
				reason: guarded.reason ?? null,
				telemetry,
				state: exchangePolicyState,
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
			? renderExchangeCollectedGrounding(
					buildExchangeCollected(input.userMessageText, history, exchangeCollected),
				)
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

		let reply: string;
		let toolCalls: ToolCallRecord[] = [];
		if (toolsActive) {
			const loop = await runToolLoop({
				chat,
				messages: msgs,
				tools,
				llmOpts,
				maxCycles: DEFAULT_MAX_TOOL_CYCLES,
			});
			toolCalls = loop.toolCalls;
			// loop.content — финальный текст; если null (исчерпал циклы) — добиваем
			// обычным complete по messages с уже вложенными tool-результатами.
			reply = loop.content ?? (await chat.complete(msgs, llmOpts));
		} else {
			reply = await chat.complete(msgs, llmOpts);
		}

		if (reply.trim().length === 0) return null;
		let guarded =
			isExchange && exchangeGuardEnabled
				? guardExchangePolicy({
						text: reply,
						telemetry: buildToolTelemetry(toolCalls),
						history,
						state: exchangePolicyState,
					})
				: {
						ok: true,
						action: "pass" as const,
						text: reply,
						reasons: [],
						requiredFixes: [],
					};
		// unbacked_quote: вместо жёсткой заглушки — один перезапрос, переписываем
		// ответ без выдуманных чисел (нет суммы → просто спросить направление+сумму).
		// Заглушку оставляем только если и перезапрос снова не прошёл.
		if (!guarded.ok && guarded.reason === "unbacked_quote") {
			const rewritten = await rewriteUnbackedQuoteReply({
				chat,
				userMessage: input.userMessageText,
				draftReply: reply,
			});
			if (rewritten) {
				const reguard = guardExchangePolicy({
					text: rewritten,
					telemetry: buildToolTelemetry(toolCalls),
					history,
					state: exchangePolicyState,
				});
				if (reguard.ok) guarded = reguard;
			}
		}
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
