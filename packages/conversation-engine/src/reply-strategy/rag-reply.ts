import type { OutboundEnvelope } from "@chatman-media/channel-core";
import {
	type AnswerTelemetry,
	type AnyRagTool,
	answerWithRag,
	buildToolTelemetry,
	DEFAULT_PERSONA,
	type DirectorHookForPrompt,
	generateSoftFallback,
	type IKbStore,
	type KbScope,
	NO_CONTEXT_MARKER,
	type Persona,
	type Reranker,
	type SkillForPrompt,
	type Style,
	StyleSchema,
	type ToolCallRecord,
} from "@chatman-media/kb";
import type {
	ChatClient,
	EmbeddingClient as RagEmbeddingClient,
} from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import {
	loadRollingConversationContext,
	messageRowsToChatHistory,
} from "../conversation-summary.ts";
import type { ConversationsRepo } from "../dal/conversations.ts";
import { ScopedKbStore } from "../dal/kb-store.ts";
import type { KbSuggestionsRepo } from "../dal/kb-suggestions.ts";
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
import {
	ANY_QUOTE_CURRENCY_MENTION_RE,
	resolveQuoteCurrency,
} from "../exchange-quote-currency.ts";
import type {
	ReplyStrategy,
	ReplyStrategyOutput,
	ReplyStrategyResult,
} from "../process-inbound.ts";
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
	type ExchangeResponseGuardFinding,
	exchangeGuardFindingFromResult,
	rewriteUnbackedQuoteReply,
} from "./exchange-reply-guard.ts";

/**
 * RAG-aware ReplyStrategy. На каждый user message:
 *   1. loadTurnContext(input) → все per-tenant/per-conversation данные хода.
 *   2. Загрузить последние N сообщений (history) + conversation compaction.
 *   3. Эмбеддинг user message → KbStore.hybridSearch → chunks.
 *   4. answerWithRag(chunks + history + system prompt) → text reply.
 *   5. Вернуть OutboundEnvelope.
 *
 * answerWithRag из @chatman-media/kb сам строит system prompt из chunks,
 * делает query rewriting + reflection (если флаги включены) и
 * sanitize'ит output. Мы только инжектим деп'ы и history.
 *
 * Раньше каждый источник данных был отдельным resolve*-колбэком (18 штук) —
 * scaffolding creep с «тихими» null-фолбэками. Теперь весь контекст хода
 * загружается одним loadTurnContext (#514); сборка живёт в apps/api.
 */

/** Идентификаторы хода, передаются в loadTurnContext. */
export interface RagTurnInput {
	tenantId: number;
	conversationId: number;
	contactId: number;
}

/**
 * Всё, что нужно стратегии для одного хода диалога. Поля, помеченные `?`,
 * опциональны: отсутствие поля = фича не сконфигурирована у тенанта, пайплайн
 * пропускает соответствующий блок (как раньше при отсутствии резолвера).
 */
export interface RagTurnContext {
	/** Vertical template тенанта. Используется для exchange-guard'ов (slug). */
	template: VerticalTemplate;
	/**
	 * true → стадия лида в support-mode: бот молчит (возвращает null), оператор
	 * ведёт диалог вручную. Loader может вернуть минимальный контекст с этим
	 * флагом и не грузить остальное.
	 */
	isSupport?: boolean;
	chat: ChatClient;
	embedder: RagEmbeddingClient;
	kb: IKbStore;
	/**
	 * Scope для retrieval (stage → funnel → global). Также логируется в
	 * kb_suggestions при no-context fallback'е.
	 */
	kbScope?: KbScope | null;
	/**
	 * Sales-style: persona, framework, hooks для system-prompt'а. null →
	 * answerWithRag fallback'нет на DEFAULT_PERSONA. Если содержит
	 * styleId/experimentId — assignment сохраняется в conversations для
	 * coach/eval attribution.
	 */
	style?: ResolvedStyleAssignment | null;
	/** Включённые навыки убеждения (уже отфильтрованы по is_enabled). */
	skills?: readonly SkillForPrompt[];
	/** Активные директорские хуки тенанта (is_active = true). */
	directorHooks?: readonly DirectorHookForPrompt[];
	/** Agentic tools. Пусто/absent → один LLM-вызов без tool-loop'а. */
	tools?: AnyRagTool[];
	/** Cross-encoder reranker (Jina/Cohere) или null. */
	reranker?: Reranker | null;
	/** Per-стадийные инструкции (goal/guidance) из stage_definitions. */
	stageGuidance?: { goal: string; guidance?: string } | null;
	/** Динамический контекст запроса (multi-request / concierge). */
	requestContext?: string | null;
	/**
	 * Factual brokered-order context текущего клиента. Мёржится в
	 * requestContext и идёт grounding-блоком; не мутирует order state.
	 */
	serviceOrderContext?: string | null;
	/** true → в промпт идёт блок «ОЖИДАНИЕ ОПЕРАТОРА» (бот держит, не выдумывает цену). */
	awaitingOperator?: boolean;
	/** Снапшот exchange-workflow state для финального policy guard (только exchange_v1). */
	exchangePolicyState?: ExchangePolicyState | null;
	/**
	 * Поля заявки, собранные УНИВЕРСАЛЬНЫМ движком воронки (field-extractor →
	 * leadFieldValues): что отдаёт клиент/сумма/сеть/выдача/оплата. Источник
	 * правды для форс-ответов обмена (вместо regex-парсинга реплик). null/absent —
	 * поля ещё не собраны (форс-слой fallback'нет на парсинг истории — пока).
	 */
	exchangeCollected?: ExchangeCollectedInput | null;
	/** false → exchange response guard bypassed for this tenant. Default: true. */
	exchangeResponseGuardEnabled?: boolean;
	/** false → hard handoff stops AI silently without sending fallback to customer. */
	exchangeCustomerNoticeEnabled?: boolean;
	/** Repo для fire-and-forget логирования незакрытых вопросов (softFallback). */
	suggestions?: KbSuggestionsRepo | null;
	/** Repo для compaction summary + style assignment. Absent → ничего не персистится. */
	conversations?: ConversationsRepo | null;
	messages: MessagesRepo;
}

export interface RagReplyStrategyOpts {
	/**
	 * Загрузить контекст хода. Вызывается один раз на каждый входящий message.
	 * Сборка (DB-запросы, кеши, метрики-обёртки) — на стороне приложения;
	 * независимые источники стоит грузить параллельно (Promise.all).
	 */
	loadTurnContext: (
		input: RagTurnInput,
	) => Promise<RagTurnContext> | RagTurnContext;
	/** Лимит history сообщений (default 12 — answerWithRag сам ужмёт через summary). */
	historyLimit?: number;
	/**
	 * Per-tenant override окна истории (заменяет historyLimit). Резолвится из
	 * tenants.reply_history_limit; NULL/ошибка → historyLimit.
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
	/**
	 * Включить hybrid retrieval (vector + BM25 RRF). Default true.
	 * False = pure vector — быстрее, но хуже на keyword-questions.
	 */
	hybridSearch?: boolean;
	/**
	 * Query rewriting перед retrieval (LLM-вызов до search). Default false (#515):
	 * замер на двух режимах корпуса не показал вклада (hybrid retrieval справляется
	 * с follow-up'ами сам), а шаг стоит +1 LLM-вызов на каждом ходе с историей.
	 * Включать точечно, если у тенанта подтверждена польза на его KB.
	 */
	rewriteQueryBeforeRetrieval?: boolean;
	/**
	 * Reflection-guard после генерации (LLM фактчекит chunks vs answer).
	 * Default: только для exchange_v1 — дополнительная LLM-стоимость и latency.
	 */
	reflect?: boolean;
	/** topK chunks для контекста. Default 5. */
	topK?: number;
	maxOutputTokens?: number;
	/**
	 * Если true — когда RAG не находит контекста (NO_CONTEXT_MARKER) бот всё
	 * равно отвечает через `generateSoftFallback` (честное «уточню и вернусь»
	 * без выдумывания конкретики). Вопрос при этом логируется в kb_suggestions.
	 *
	 * Если false (по умолчанию) — бот молчит (возвращает null), как раньше.
	 */
	softFallback?: boolean;
	/**
	 * Conversation compaction: если кол-во сообщений в диалоге достигает порога —
	 * pipeline генерирует резюме и сохраняет его в conversations.summary_json.
	 * Резюме передаётся в answerWithRag как conversationSummary, сокращая effective
	 * history window и предотвращая overflow LLM context.
	 *
	 * Default: 20. Отключить: 0 или Infinity.
	 */
	compactAfterMessages?: number;
	/**
	 * Optional post-generation telemetry sink for agentic tool calls. Called only
	 * after the LLM/tool loop finishes, so it never wraps an LLM call in a DB tx.
	 */
	recordToolCalls?: (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
		userMessageText: string;
		assistantText: string;
		telemetry: AnswerTelemetry;
		guardFindings?: readonly ExchangeResponseGuardFinding[];
	}) => Promise<void> | void;
}

/**
 * Helper: распарсить style.config_json (из storage StyleRow) в типизированный
 * rag's Style через zod StyleSchema. Возвращает null если JSON невалидный —
 * pipeline'у тогда fall back на DEFAULT_PERSONA вместо crash'а.
 *
 * Использовать снаружи (apps/api) при построении style-части TurnContext:
 *   const styleRow = await stylesRepo.findActiveBySlug(slug);
 *   return parseStyleConfig(styleRow.configJson);
 */
export function parseStyleConfig(configJson: string): Style | null {
	try {
		const raw = JSON.parse(configJson);
		return StyleSchema.parse(raw);
	} catch {
		return null;
	}
}

export type ResolvedStyleAssignment = Style & {
	styleId?: number | null;
	experimentId?: number | null;
	experimentSlug?: string | null;
	variantSlug?: string | null;
};

/**
 * Сырые значения полей заявки, собранные универсальным движком (apps/api
 * readExchangeCollectedFields → ctx). asset/network — в формате тулов
 * (usdt/trc20), payout/payment — enum'ы (atm/card_transfer).
 */
export interface ExchangeCollectedInput {
	asset?: string;
	amount?: number;
	network?: string;
	payoutMethod?: string;
	paymentMethod?: string;
}

type ExchangeOrderArgs = {
	asset: string;
	amount: number;
	amountMode: "source_amount";
	network?: string;
	paymentMethod?: string;
	payoutMethod?: string;
};

type ExchangeQuoteArgs = {
	asset: string;
	amount: number;
	amountMode: "source_amount";
	network?: string;
};

type ExchangeForcedReply = {
	text: string;
	toolCalls: ToolCallRecord[];
};

const EXCHANGE_QUOTE_FOLLOWUP_RE =
	/курс|rate|сколько|получ(?:у|ится|ить)|итого|посчитай|рассчитай|пересчитай/iu;
const EXCHANGE_ORDER_CONFIRMATION_RE =
	/(?:^|[\s,.!?])(?:да|ок|окей|ok|okay|супер|класс|топ|отл(?:ично)?|хорошо|хор|норм(?:ально)?|год(?:ится|но)|ага|угу|ид[её]т|пойд[её]т|беру|давай(?:те)?|подходит|готов(?:ы)?|оформ[а-яё]*|создава[а-яё]*|делаем|погнали|впер[её]д|соглас(?:ен|на)?|договорились|подтвержда[а-яё]*|лады|ладно|начинаем|поехали)(?:$|[\s,.!?])/iu;
const EXCHANGE_KYC_MATERIAL_SENT_RE =
	/(?:отправил|отправила|прислал|прислала|загрузил|загрузила|вот|держи|лови)[^.!\n]{0,80}(?:видео|кружок|документ|паспорт)|(?:видео|кружок|документ|паспорт)[^.!\n]{0,80}(?:отправил|отправила|прислал|прислала|загрузил|загрузила)/iu;

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

function exchangeAssetMentionRe(asset: string): RegExp {
	switch (asset) {
		case "USDT":
			return /\busdt\b|юсдт/iu;
		case "BTC":
			return /\bbtc\b|битк/iu;
		case "ETH":
			return /\beth\b|эфир/iu;
		case "RUB":
			return /\brub\b|руб|₽/iu;
		case "EUR":
			return /\beur\b|евро/iu;
		case "USD":
			return /\busd\b|доллар|бакс/iu;
		default:
			return new RegExp(`\\b${asset}\\b`, "iu");
	}
}

/** Сеть USDT из текста (TRC20/ERC20/BEP20) или undefined. */
function parseNetwork(text: string): string | undefined {
	return /trc[\s-]?20|tron/iu.test(text)
		? "TRC20"
		: /erc[\s-]?20/iu.test(text)
			? "ERC20"
			: /bep[\s-]?20|bsc/iu.test(text)
				? "BEP20"
				: undefined;
}

// Поддерживаемые сети — для отказа по неподдерживаемым (см. ниже). \b не работает
// по кириллице, поэтому supported-набор латиницей и матчится свободно.
const EXCHANGE_SUPPORTED_NETWORK_RE = /trc[\s-]?20|tron|erc[\s-]?20|bep[\s-]?20|\bbsc\b/iu;

// Юникод-границы слова: \b в JS опирается на ASCII \w и не ставит границу вокруг
// кириллицы (см. #612). Берём явные lookaround'ы по \p{L}\p{N}.
const NETWORK_NB_L = "(?<![\\p{L}\\p{N}])";
const NETWORK_NB_R = "(?![\\p{L}\\p{N}])";

/**
 * Известные, но НЕ поддерживаемые нами сети для USDT (TON/Solana/…). Раньше
 * экстрактор молча не извлекал такую сеть → бот переспрашивал в пустоту (#655).
 * Это интент-классификатор отказа, а не сбор поля — переживает выпил regex (#654).
 */
const EXCHANGE_UNSUPPORTED_NETWORKS: ReadonlyArray<{ re: RegExp; name: string }> =
	[
		{
			re: new RegExp(`${NETWORK_NB_L}(?:ton(?:coin)?|тон|тонкоин)${NETWORK_NB_R}`, "iu"),
			name: "TON",
		},
		{
			re: new RegExp(`${NETWORK_NB_L}(?:solana|солана|spl|спл)${NETWORK_NB_R}`, "iu"),
			name: "Solana",
		},
		{
			re: new RegExp(`${NETWORK_NB_L}(?:polygon|полигон|matic|матик)${NETWORK_NB_R}`, "iu"),
			name: "Polygon",
		},
		{
			re: new RegExp(`${NETWORK_NB_L}(?:avalanche|avax|аваланч)${NETWORK_NB_R}`, "iu"),
			name: "Avalanche",
		},
		{
			re: new RegExp(`${NETWORK_NB_L}(?:arbitrum|арбитрум)${NETWORK_NB_R}`, "iu"),
			name: "Arbitrum",
		},
		{
			re: new RegExp(`${NETWORK_NB_L}(?:optimism|оптимизм)${NETWORK_NB_R}`, "iu"),
			name: "Optimism",
		},
	];

/** Каноничное имя неподдерживаемой сети из текста, иначе null. */
function detectUnsupportedExchangeNetwork(text: string): string | null {
	if (EXCHANGE_SUPPORTED_NETWORK_RE.test(text)) return null;
	for (const { re, name } of EXCHANGE_UNSUPPORTED_NETWORKS) {
		if (re.test(text)) return name;
	}
	return null;
}

/**
 * Явный отказ, когда клиент называет неподдерживаемую сеть (TON и пр.): не молчим
 * и не подставляем дефолт — просим выбрать TRC20/ERC20/BEP20.
 */
function maybeForceExchangeUnsupportedNetwork(input: {
	userMessageText: string;
}): ExchangeForcedReply | null {
	const network = detectUnsupportedExchangeNetwork(input.userMessageText);
	if (!network) return null;
	return {
		text: `Сеть ${network} мы не поддерживаем — принимаем USDT только в сетях TRC20, ERC20 или BEP20. В какой из них отправите?`,
		toolCalls: [],
	};
}

function parseExchangeSourceArgs(text: string): ExchangeOrderArgs | null {
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

	const matches = [
		...text.matchAll(/\d+(?:[ \u00a0]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g),
	];
	for (const match of matches) {
		const raw = match[0];
		const start = match.index ?? 0;
		const end = start + raw.length;
		const before = text.slice(Math.max(0, start - 24), start).toLowerCase();
		const after = text.slice(end, end + 24).toLowerCase();
		const amount = parseExchangeAmountToken(raw);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		// Множитель «тысяч» (10к / 5 тыс / 100k) — ТОЛЬКО как суффикс сразу после
		// числа. Раньше regex искал «к» по всему окну `after`; обрезанное на
		// границе 24 символов слово (напр. «…Какой» → «к») ложно давало ×1000:
		// «500 USDT … Какой курс» парсилось как 500000.
		const afterTrimmed = after.trimStart();
		const multiplier = /^(?:тыс|к(?![а-яёa-z])|k\b)/iu.test(afterTrimmed)
			? 1000
			: 1;
		const window = `${before}${raw}${after}`;
		if (!exchangeAssetMentionRe(asset).test(window)) continue;
		const network = parseNetwork(text);
		return {
			asset,
			amount: amount * multiplier,
			amountMode: "source_amount",
			...(network ? { network } : {}),
			paymentMethod: asset === "RUB" ? "bank_transfer" : "crypto_transfer",
			...(/банкомат|atm/iu.test(text) ? { payoutMethod: "atm" } : {}),
		};
	}
	return null;
}

function parseExchangeQuoteArgs(text: string): ExchangeQuoteArgs | null {
	const parsed = parseExchangeSourceArgs(text);
	if (!parsed) return null;
	return {
		asset: parsed.asset,
		amount: parsed.amount,
		amountMode: "source_amount",
		...(parsed.network ? { network: parsed.network } : {}),
	};
}

function latestExchangeQuoteArgs(
	history: MessageRow[],
	userMessageText: string,
): ExchangeQuoteArgs | null {
	const current = parseExchangeQuoteArgs(userMessageText);
	if (current) return current;
	if (!EXCHANGE_QUOTE_FOLLOWUP_RE.test(userMessageText)) return null;
	for (const item of [...history].reverse()) {
		if (item.role !== "user") continue;
		const parsed = parseExchangeQuoteArgs(item.text);
		if (parsed) return parsed;
	}
	return null;
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
	if (typeof row.error === "string" && row.error.trim())
		return row.error.trim();
	const amountToThb = numberLike(row.amountToThb);
	if (amountToThb === null) return null;
	const directionQuote =
		typeof row.direction === "string" ? row.direction.split("->")[1] : null;
	const currency = resolveQuoteCurrency(
		typeof row.quoteAsset === "string" ? row.quoteAsset : directionQuote,
	);
	// Тёплая, живая формулировка (не сухое «Получите X»). Число/валюта — от
	// compute_quote, поэтому guard пропускает. Исходную сумму повторяем, чтобы
	// она оставалась в истории и LLM на следующих ходах не «терял» её.
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
// Способ оплаты по СБП/QR vs картой/переводом/банком. Проверяется по репликам
// клиента, не по тексту бота — requisites-guard здесь не применяется.
const EXCHANGE_PAYMENT_SBP_RE =
	/\bqr\b|сбп|sbp|через\s+(?:банк-?)?приложен|мобильн\w*\s*банк/iu;
const EXCHANGE_PAYMENT_CARD_RE =
	/картой|на\s+карт|по\s+карт|\bcard\b|перевод\w*|\bсбер\b|сбербанк|тинькоф\w*|t-?bank|\bальфа\b|райфф\w*|\bвтб\b|газпромбанк|на\s+сч[её]т|со\s+сч[её]т|банковск\w*/iu;

function parsePaymentMethod(text: string): string | null {
	if (EXCHANGE_PAYMENT_SBP_RE.test(text)) return "sbp_qr";
	if (EXCHANGE_PAYMENT_CARD_RE.test(text)) return "card_transfer";
	return null;
}

/** Способ ВЫДАЧИ денег клиенту (получить PHP) из текста, или undefined. */
function parsePayoutMethod(text: string): string | undefined {
	if (/банкомат|atm/iu.test(text)) return "atm";
	if (/офис/iu.test(text)) return "office_cash";
	if (/наличны/iu.test(text)) return "office_cash";
	if (/курьер/iu.test(text)) return "courier_cash";
	if (
		/тайск\w*\s*банк|thai\s*bank|bangkok|kbank|scb|зачисл|банк(?:овск)?\w*\s+сч[её]т/iu.test(
			text,
		)
	)
		return "thai_bank_transfer";
	return undefined;
}

/**
 * Вопрос о недостающих параметрах ПОСЛЕ котировки: вести к заявке, а не замирать
 * на «Получите X». Спрашиваем: (1) сеть USDT, если клиент не указал — иначе
 * кошелёк уйдёт в дефолтную TRC20, которая может быть не та; (2) способ выдачи.
 * Способ ОПЛАТЫ (СБП/карта) выносим в отдельный шаг (maybeForceExchangePaymentMethodQuestion)
 * — слова «сбп/qr/карта/перевод» + число котировки в одном тексте триггерят
 * requisites-guard → фоллбэк. В отдельном ходу числа нет → guard пропускает.
 * networkKnown — клиент уже назвал сеть. Сканируем только реплики клиента.
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

async function maybeForceExchangeQuoteReply(input: {
	userMessageText: string;
	history: MessageRow[];
	tools: AnyRagTool[];
}): Promise<ExchangeForcedReply | null> {
	if (EXCHANGE_KYC_MATERIAL_SENT_RE.test(input.userMessageText)) return null;
	const quoteTool = input.tools.find(
		(tool) => tool.name === "compute_exchange_quote",
	);
	if (!quoteTool) return null;
	const args = latestExchangeQuoteArgs(input.history, input.userMessageText);
	if (!args) return null;
	const result = await quoteTool.execute(args);
	const text = forcedExchangeQuoteText(result);
	if (!text) return null;
	// После котировки дособираем способ выдачи/оплаты (если клиент ещё не назвал),
	// чтобы вести к заявке, а не замирать на «Получите X».
	const userText = [
		input.userMessageText,
		...input.history.filter((m) => m.role === "user").map((m) => m.text),
	].join("\n");
	const ask = exchangeMissingFieldsQuestion(
		userText,
		args.asset,
		Boolean(args.network),
	);
	return {
		text: ask ? `${text}\n\n${ask}` : text,
		toolCalls: [{ name: quoteTool.name, args, result, cycle: 0 }],
	};
}

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

/**
 * Единый снимок собранных полей заявки из реплик клиента. Источник правды для
 * грунтинга промпта, вопроса оплаты и сводки-подтверждения — чтобы бот не терял
 * контекст и не переспрашивал уже названное. `missing` — список обязательных
 * полей, которых ещё нет (amount/network/payout/payment).
 */
type ExchangeCollected = {
	asset: string | null;
	amount: number | null;
	network: string | null;
	payoutMethod: string | null;
	paymentMethod: string | null;
	missing: string[];
};

function buildExchangeCollected(
	userMessageText: string,
	history: MessageRow[],
	injected?: ExchangeCollectedInput | null,
): ExchangeCollected {
	// Универсально собранное (ctx из leadFieldValues) — ПРИОРИТЕТ; regex-парсинг
	// реплик остаётся per-field fallback'ом, пока не подтверждена надёжность
	// экстрактора на проде. asset/network приводим к ВЕРХНЕМУ регистру (формат
	// тулов/меток): инжект приходит как usdt/trc20, regex даёт USDT/TRC20.
	const userTexts = [
		userMessageText,
		...history
			.filter((m) => m.role === "user")
			.map((m) => m.text)
			.reverse(),
	];
	let base: ExchangeOrderArgs | null = null;
	for (const t of userTexts) {
		const parsed = parseExchangeSourceArgs(t);
		if (parsed) {
			base = parsed;
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

// Метки для сводки/грунтинга. ВАЖНО: формулировки без слов
// оплат*/перевод/карта/qr/сбп/реквизит — иначе текст с числом котировки
// триггерит requisites-guard (см. exchange-reply-guard).
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

/**
 * Грунтинг-блок «что уже собрано» для system-prompt (через requestContext).
 * Идёт в ПРОМПТ, не в ответ — guard к нему не применяется. Чинит «уточните
 * сумму»: LLM всегда видит сумму/направление, даже если forced-шаги не сработали.
 */
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
 * Отдельный ход важен: числа котировки нет → guard пропускает слова qr/сбп/карта.
 * Гейт через единый buildExchangeCollected: актив=RUB, способ выдачи известен,
 * способ оплаты ещё НЕ назван — для крипты вопрос не задаём (crypto_transfer).
 */
function maybeForceExchangePaymentMethodQuestion(input: {
	userMessageText: string;
	history: MessageRow[];
	injected?: ExchangeCollectedInput | null;
}): ExchangeForcedReply | null {
	// Несерьёзные / длинные сообщения оставляем LLM
	if (input.userMessageText.trim().length > 300) return null;
	if (!hasRecentExchangeQuote(input.history)) return null;
	const collected = buildExchangeCollected(
		input.userMessageText,
		input.history,
		input.injected,
	);
	if (collected.asset !== "RUB") return null; // крипта → crypto_transfer авто
	if (collected.paymentMethod) return null; // уже назван
	if (!collected.payoutMethod) return null; // сперва способ выдачи
	if (EXCHANGE_ORDER_CONFIRMATION_RE.test(input.userMessageText)) return null;
	// Не повторяем, если уже спрашивали в последних 4 сообщениях
	const alreadyAsked = input.history
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

function latestExchangeOrderArgs(
	history: MessageRow[],
	userMessageText: string,
): ExchangeOrderArgs | null {
	const joinedText = [userMessageText, ...history.map((m) => m.text)].join(
		"\n",
	);
	const fallbackPayoutMethod = /банкомат|atm/iu.test(joinedText)
		? "atm"
		: undefined;
	const userTexts = [
		userMessageText,
		...history.filter((m) => m.role === "user").map((m) => m.text),
	];
	const detectedPaymentMethod =
		userTexts.map(parsePaymentMethod).find(Boolean) ?? null;
	for (const item of [...history].reverse()) {
		const parsed = parseExchangeSourceArgs(item.text);
		if (!parsed) continue;
		return {
			...parsed,
			...(parsed.payoutMethod || !fallbackPayoutMethod
				? {}
				: { payoutMethod: fallbackPayoutMethod }),
			...(detectedPaymentMethod
				? { paymentMethod: detectedPaymentMethod }
				: {}),
		};
	}
	return null;
}

function forcedExchangeOrderText(result: unknown): string | null {
	if (!result || typeof result !== "object") return null;
	const row = result as Record<string, unknown>;
	if (typeof row.error === "string" && row.error.trim()) return row.error;
	if (row.needsVerification === true) {
		return (
			(typeof row.instructions === "string" && row.instructions.trim()
				? row.instructions.trim()
				: null) ??
			"Для обмена нужно пройти верификацию: пришлите документ, удостоверяющий личность, и короткое видео/кружок с ФИО и фразой о направлении обмена."
		);
	}
	if (typeof row.orderId === "number") {
		return "Отлично, заявку оформил! 🙌 Секунду — подготовлю реквизиты для оплаты.";
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

async function maybeForceExchangeOrderReply(input: {
	userMessageText: string;
	history: MessageRow[];
	state: ExchangePolicyState | null;
	tools: AnyRagTool[];
}): Promise<ExchangeForcedReply | null> {
	if (
		input.state?.stageSlug !== "quote_calculated" &&
		!hasRecentExchangeQuote(input.history)
	) {
		return null;
	}
	if (!EXCHANGE_ORDER_CONFIRMATION_RE.test(input.userMessageText)) return null;
	if (EXCHANGE_KYC_MATERIAL_SENT_RE.test(input.userMessageText)) return null;
	const createOrderTool = input.tools.find(
		(tool) => tool.name === "create_exchange_order",
	);
	if (!createOrderTool) return null;
	const args = latestExchangeOrderArgs(input.history, input.userMessageText);
	if (!args) return null;
	const result = await createOrderTool.execute(args);
	const text = forcedExchangeOrderText(result);
	if (!text) return null;
	const toolCalls: ToolCallRecord[] = [
		{ name: createOrderTool.name, args, result, cycle: 0 },
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
		const fetchTool = input.tools.find(
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
				console.warn("[rag-reply] forced requisites fetch failed:", err);
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
 * не подтвердил. Закрывает тупик: раньше после «на счёт, сбер» ни один forced-шаг
 * не срабатывал и управление уходило в LLM (→ «уточните сумму»). Число берём от
 * повторного compute_exchange_quote (backing → guard пропускает).
 */
async function maybeForceExchangeSummaryConfirm(input: {
	userMessageText: string;
	history: MessageRow[];
	state: ExchangePolicyState | null;
	tools: AnyRagTool[];
	injected?: ExchangeCollectedInput | null;
}): Promise<ExchangeForcedReply | null> {
	if (input.userMessageText.trim().length > 300) return null;
	if (
		input.state?.stageSlug !== "quote_calculated" &&
		!hasRecentExchangeQuote(input.history)
	) {
		return null;
	}
	// «да»/«ок» → дальше создаём заявку (maybeForceExchangeOrderReply), не сводку.
	if (EXCHANGE_ORDER_CONFIRMATION_RE.test(input.userMessageText)) return null;
	if (EXCHANGE_KYC_MATERIAL_SENT_RE.test(input.userMessageText)) return null;
	const collected = buildExchangeCollected(
		input.userMessageText,
		input.history,
		input.injected,
	);
	if (collected.missing.length > 0) return null;
	if (!collected.asset || !collected.amount) return null;
	// Сводку не повторяем, если уже показали в текущем эпизоде заявки.
	if (exchangeSummaryAlreadyShown(input.history)) return null;
	const quoteTool = input.tools.find(
		(tool) => tool.name === "compute_exchange_quote",
	);
	if (!quoteTool) return null;
	const quoteArgs: ExchangeQuoteArgs = {
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

function hasAssignmentMetadata(style: ResolvedStyleAssignment | null): boolean {
	return style?.styleId !== undefined || style?.experimentId !== undefined;
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

export class RagReplyStrategy implements ReplyStrategy {
	constructor(private readonly opts: RagReplyStrategyOpts) {}

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
		const ctx = await this.opts.loadTurnContext({
			tenantId,
			conversationId: input.conversationId,
			contactId: input.contactId,
		});

		if (ctx.isSupport) return null;

		const { template, chat, messages: messagesRepo } = ctx;
		let recentWindow = this.opts.historyLimit ?? 12;
		if (this.opts.resolveHistoryLimit) {
			try {
				const v = await this.opts.resolveHistoryLimit({ tenantId });
				if (typeof v === "number" && Number.isFinite(v) && v >= 2)
					recentWindow = v;
			} catch (err) {
				console.warn("[rag-reply] failed to resolve history limit:", err);
			}
		}
		// #623 — per-tenant override параметров генерации (rag отдаёт numPredict +
		// порог сжатия; temperature внутри answerWithRag/style, не трогаем).
		let genMaxTokens = this.opts.maxOutputTokens ?? 600;
		let genCompactAfter = this.opts.compactAfterMessages ?? 20;
		if (this.opts.resolveGenerationParams) {
			try {
				const g = await this.opts.resolveGenerationParams({ tenantId });
				if (g) {
					if (typeof g.maxOutputTokens === "number" && g.maxOutputTokens > 0)
						genMaxTokens = g.maxOutputTokens;
					if (
						typeof g.compactAfterMessages === "number" &&
						g.compactAfterMessages > 0
					)
						genCompactAfter = g.compactAfterMessages;
				}
			} catch (err) {
				console.warn("[rag-reply] failed to resolve generation params:", err);
			}
		}
		const { history: historyWithoutCurrent, conversationSummary } =
			await loadRollingConversationContext({
				conversationId: input.conversationId,
				messages: messagesRepo,
				conversations: ctx.conversations ?? null,
				chat,
				...(input.userMessageId !== undefined
					? { currentMessageId: input.userMessageId }
					: { currentMessageText: input.userMessageText }),
				options: {
					recentWindow,
					summarizeAfterMessages: genCompactAfter,
				},
				onWarn: (_message, err) => {
					console.warn("[rag-reply] conversation summary failed:", err);
				},
			});
		const history = messageRowsToChatHistory(historyWithoutCurrent);

		const kbScope = ctx.kbScope ?? null;
		const kb = kbScope ? new ScopedKbStore(ctx.kb, kbScope) : ctx.kb;
		const style = ctx.style ?? null;
		if (style && hasAssignmentMetadata(style)) {
			const convsRepo = ctx.conversations;
			if (convsRepo) {
				await convsRepo
					.setAssignment(input.conversationId, {
						...(style.styleId !== undefined ? { styleId: style.styleId } : {}),
						...(style.experimentId !== undefined
							? { experimentId: style.experimentId }
							: {}),
					})
					.catch((err) =>
						console.warn("[rag-reply] failed to save style assignment:", err),
					);
			}
		}

		const isExchange = template?.slug === "exchange_v1";

		const skills = ctx.skills ?? [];
		const directorHooks = ctx.directorHooks ?? [];
		const tools = ctx.tools ?? [];
		const reranker = ctx.reranker ?? null;
		const stageGuidance = ctx.stageGuidance ?? null;
		const requestContext = ctx.requestContext ?? null;
		const serviceOrderContext = ctx.serviceOrderContext ?? null;
		const awaitingOperator = ctx.awaitingOperator ?? false;
		const exchangePolicyState = isExchange
			? (ctx.exchangePolicyState ?? null)
			: null;
		const exchangeCollected = isExchange ? (ctx.exchangeCollected ?? null) : null;

		const forcedExchangeReply = isExchange
			? ((await maybeForceExchangeOrderReply({
					userMessageText: input.userMessageText,
					history: historyWithoutCurrent,
					state: exchangePolicyState,
					tools,
				})) ??
				maybeForceExchangeUnsupportedNetwork({
					userMessageText: input.userMessageText,
				}) ??
				(await maybeForceExchangeQuoteReply({
					userMessageText: input.userMessageText,
					history: historyWithoutCurrent,
					tools,
				})) ??
				maybeForceExchangePaymentMethodQuestion({
					userMessageText: input.userMessageText,
					history: historyWithoutCurrent,
					injected: exchangeCollected,
				}) ??
				(await maybeForceExchangeSummaryConfirm({
					userMessageText: input.userMessageText,
					history: historyWithoutCurrent,
					state: exchangePolicyState,
					tools,
					injected: exchangeCollected,
				})))
			: null;
		if (forcedExchangeReply) {
			const telemetry: AnswerTelemetry = {
				path: "ok",
				...buildToolTelemetry(forcedExchangeReply.toolCalls),
			};
			const guarded =
				(ctx.exchangeResponseGuardEnabled ?? true)
					? guardExchangePolicy({
							text: forcedExchangeReply.text,
							telemetry,
							history: historyWithoutCurrent,
							state: exchangePolicyState,
						})
					: {
							ok: true,
							action: "pass" as const,
							text: forcedExchangeReply.text,
							reasons: [],
							requiredFixes: [],
						};
			const guardFinding =
				(ctx.exchangeResponseGuardEnabled ?? true)
					? exchangeGuardFindingFromResult(guarded)
					: null;
			if (this.opts.recordToolCalls) {
				try {
					await this.opts.recordToolCalls({
						tenantId,
						conversationId: input.conversationId,
						contactId: input.contactId,
						userMessageText: input.userMessageText,
						assistantText: guarded.text,
						telemetry,
						...(guardFinding ? { guardFindings: [guardFinding] } : {}),
					});
				} catch (err) {
					console.warn(
						"[rag-reply] failed to record forced exchange tool call:",
						err,
					);
				}
			}
			const operatorHandoff =
				buildExchangeOperatorHandoff({
					text: guarded.text,
					telemetry,
					state: exchangePolicyState,
				}) ??
				(guarded.action === "escalate" || guarded.action === "block"
					? buildExchangeGenericOperatorHandoff({
							state: exchangePolicyState,
							context: guarded.reason ?? null,
						})
					: null);
			return exchangeReplyOutput({
				channelId: input.channel.channelId,
				externalUserId: input.inbound.externalUserId,
				text: guarded.text,
				operatorHandoff,
				customerNoticeEnabled: ctx.exchangeCustomerNoticeEnabled ?? true,
			});
		}

		// Грунтинг exchange-состояния: что клиент уже назвал (сумма/направление/
		// выдача/оплата). Идёт в промпт — LLM не теряет сумму и не переспрашивает.
		const exchangeGrounding = isExchange
			? renderExchangeCollectedGrounding(
					buildExchangeCollected(
						input.userMessageText,
						historyWithoutCurrent,
						exchangeCollected,
					),
				)
			: null;
		const combinedRequestContext =
			[requestContext, serviceOrderContext, exchangeGrounding]
				.map((value) => value?.trim())
				.filter(Boolean)
				.join("\n\n") || null;
		const serviceOrderGrounding = serviceOrderContext?.trim() || null;

		// answerWithRag принимает rag's ChatClient/EmbeddingClient. Структурно
		// наш llm-router'овский ChatClient compatible (rag's ChatMessage.content
		// допускает null — наш string ужe; complete(messages, opts?) совпадает).
		// Если TS жалуется на nominal-mismatch — даём structural cast.
		const result = await answerWithRag({
			question: input.userMessageText,
			kb,
			embedder: ctx.embedder,
			chat: chat as unknown as Parameters<typeof answerWithRag>[0]["chat"],
			history: history as unknown as Parameters<
				typeof answerWithRag
			>[0]["history"],
			topK: this.opts.topK ?? 5,
			hybridSearch: this.opts.hybridSearch ?? true,
			rewriteQueryBeforeRetrieval:
				this.opts.rewriteQueryBeforeRetrieval ?? false,
			reflect: this.opts.reflect ?? isExchange,
			numPredict: genMaxTokens,
			// Style: если контекст содержит Style — answerWithRag использует его
			// persona, sales framework, hooks, skills для построения system prompt.
			// При null — rag fallback'нет на DEFAULT_PERSONA и базовый промпт.
			...(style ? { style } : {}),
			...(skills.length > 0 ? { skills } : {}),
			...(directorHooks.length > 0 ? { directorHooks } : {}),
			...(tools.length > 0 ? { tools } : {}),
			...(reranker ? { reranker } : {}),
			...(conversationSummary ? { conversationSummary } : {}),
			...(stageGuidance ? { stageOverride: stageGuidance } : {}),
			...(combinedRequestContext
				? { requestContext: combinedRequestContext }
				: {}),
			...(serviceOrderGrounding
				? { vacanciesBlock: serviceOrderGrounding, vacancyGuard: false }
				: {}),
			...(awaitingOperator ? { awaitingOperator } : {}),
		});

		// ── Soft fallback when RAG has no context ────────────────────────────────
		if (
			result.text === NO_CONTEXT_MARKER ||
			!result.text ||
			result.text.trim().length === 0
		) {
			// Fire-and-forget: log unanswered question for the KB suggestions queue.
			if (ctx.suggestions) {
				const nowEpoch = Math.floor(Date.now() / 1000);
				ctx.suggestions
					.log({
						questionText: input.userMessageText,
						sourceConversationId: input.conversationId,
						...(kbScope ? { scope: kbScope } : {}),
						nowEpoch,
					})
					.catch((err) => {
						console.warn("[rag-reply] failed to log kb_suggestion:", err);
					});
			}

			if (isExchange) {
				console.warn(
					`[exchange-reflect-guard] tenant=${tenantId} conversation=${input.conversationId} path=${result.telemetry.path}`,
				);
				return [
					{
						channelId: String(input.channel.channelId),
						externalUserId: input.inbound.externalUserId,
						parts: [{ kind: "text", text: EXCHANGE_SAFE_FALLBACK }],
					},
				];
			}

			if (!this.opts.softFallback) return null;

			// Derive persona: from style (if set) or DEFAULT_PERSONA.
			const persona: Persona = style
				? {
						name: style.persona.name,
						role: style.persona.role,
						...(style.persona.company?.trim()
							? { company: style.persona.company.trim() }
							: {}),
					}
				: DEFAULT_PERSONA;

			const fallbackText = await generateSoftFallback({
				question: input.userMessageText,
				chat: chat as unknown as Parameters<
					typeof generateSoftFallback
				>[0]["chat"],
				persona,
				history: history as unknown as Parameters<
					typeof generateSoftFallback
				>[0]["history"],
			});

			if (!fallbackText || fallbackText.trim().length === 0) return null;

			return [
				{
					channelId: String(input.channel.channelId),
					externalUserId: input.inbound.externalUserId,
					parts: [{ kind: "text", text: fallbackText }],
				},
			];
		}

		const exchangeGuardEnabled = ctx.exchangeResponseGuardEnabled ?? true;
		let guarded =
			isExchange && exchangeGuardEnabled
				? guardExchangePolicy({
						text: result.text,
						telemetry: result.telemetry,
						history: historyWithoutCurrent,
						state: exchangePolicyState,
					})
				: {
						ok: true,
						action: "pass" as const,
						text: result.text,
						reasons: [],
						requiredFixes: [],
					};
		// unbacked_quote: один перезапрос вместо жёсткой заглушки (см. llm-reply).
		if (!guarded.ok && guarded.reason === "unbacked_quote") {
			const rewritten = await rewriteUnbackedQuoteReply({
				chat,
				userMessage: input.userMessageText,
				draftReply: result.text,
			});
			if (rewritten) {
				const reguard = guardExchangePolicy({
					text: rewritten,
					telemetry: result.telemetry,
					history: historyWithoutCurrent,
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

		if (
			this.opts.recordToolCalls &&
			((result.telemetry.toolCalls?.length ?? 0) > 0 ||
				result.telemetry.toolCall ||
				guardFinding)
		) {
			try {
				await this.opts.recordToolCalls({
					tenantId,
					conversationId: input.conversationId,
					contactId: input.contactId,
					userMessageText: input.userMessageText,
					assistantText: guarded.text,
					telemetry: result.telemetry,
					...(guardFinding ? { guardFindings: [guardFinding] } : {}),
				});
			} catch (err) {
				console.warn("[rag-reply] failed to record tool calls:", err);
			}
		}

		const operatorHandoff = isExchange
			? (buildExchangeOperatorHandoff({
					text: guarded.text,
					telemetry: result.telemetry,
					state: exchangePolicyState,
				}) ??
				(guarded.action === "escalate" || guarded.action === "block"
					? buildExchangeGenericOperatorHandoff({
							state: exchangePolicyState,
							context: guarded.reason ?? null,
						})
					: null))
			: null;

		return isExchange
			? exchangeReplyOutput({
					channelId: input.channel.channelId,
					externalUserId: input.inbound.externalUserId,
					text: guarded.text,
					operatorHandoff,
					customerNoticeEnabled: ctx.exchangeCustomerNoticeEnabled ?? true,
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
