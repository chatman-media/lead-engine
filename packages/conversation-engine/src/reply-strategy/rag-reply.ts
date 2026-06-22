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
  type ReplyLang,
  type Reranker,
  type SkillForPrompt,
  type Style,
  StyleSchema,
  type ToolCallRecord,
} from "@chatman-media/kb";
import type { ChatClient, EmbeddingClient as RagEmbeddingClient } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import {
  loadRollingConversationContext,
  messageRowsToChatHistory,
} from "../conversation-summary.ts";
import type { ConversationsRepo } from "../dal/conversations.ts";
import { ScopedKbStore } from "../dal/kb-store.ts";
import type { KbSuggestionsRepo } from "../dal/kb-suggestions.ts";
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
import { ANY_QUOTE_CURRENCY_MENTION_RE, resolveQuoteCurrency } from "../exchange-quote-currency.ts";
import type {
  ReplyStrategy,
  ReplyStrategyOutput,
  ReplyStrategyResult,
} from "../process-inbound.ts";
import { translateText } from "../translation.ts";
import {
  buildExchangeGenericOperatorHandoff,
  buildExchangeOperatorHandoff,
} from "./exchange-operator-handoff.ts";
import { type ExchangePolicyState, guardExchangePolicy } from "./exchange-policy-guard.ts";
import {
  EXCHANGE_SAFE_FALLBACK,
  type ExchangeResponseGuardAction,
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
  /**
   * Язык ответа клиенту (#730): из языка диалога (`conversations.detected_lang`
   * через `effectiveLang`). Прокидывается в answerWithRag → composeSystemPrompt.
   * null/absent → бот отвечает на языке Style (back-compat).
   */
  lang?: ReplyLang | null;
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
  loadTurnContext: (input: RagTurnInput) => Promise<RagTurnContext> | RagTurnContext;
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
  /**
   * Per-turn сигнал из универсального движка (#654): сумму (amount_from) на ЭТОМ
   * ходе (пере)задал field-extractor. Гейт форс-котировки: «посчитай 500 usdt»
   * (свежая сумма → считаем) vs «TRC20 в банкомате» (поля есть, суммы этого хода
   * нет → сводка/оплата). Заменяет «свежая сумма этого хода» из выпиленного regex.
   */
  amountSetThisTurn?: boolean;
  /** Аналогично amountSetThisTurn, но для актива (asset_from). */
  assetSetThisTurn?: boolean;
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
// Явный вопрос ИМЕННО про значение курса (клиент требует цифру) — тогда курс
// показываем (проактивная котировка его прячет). НЕ матчит «курс устраивает/ок».
const EXCHANGE_RATE_QUESTION_RE =
  /(?:как(?:ой|ому|ая)|по\s+как(?:ому|ой)|нужен|нужна|не\s+хватает|назов|скажите|сообщите|что\s+за|информаци)[^.?!]{0,20}курс|курс[^.?!а-яa-z]{0,3}\?|какой\s+rate/iu;
const EXCHANGE_ORDER_CONFIRMATION_RE =
  /(?:^|[\s,.!?])(?:да|ок|окей|ok|okay|супер|класс|топ|отл(?:ично)?|хорошо|хор|норм(?:ально)?|год(?:ится|но)|ага|угу|ид[её]т|пойд[её]т|беру|давай(?:те)?|подходит|готов(?:ы)?|оформ[а-яё]*|создава[а-яё]*|делаем|погнали|впер[её]д|соглас(?:ен|на)?|договорились|подтвержда[а-яё]*|лады|ладно|начинаем|поехали)(?:$|[\s,.!?])/iu;
const EXCHANGE_KYC_MATERIAL_SENT_RE =
  /(?:отправил|отправила|прислал|прислала|загрузил|загрузила|вот|держи|лови)[^.!\n]{0,80}(?:видео|кружок|документ|паспорт)|(?:видео|кружок|документ|паспорт)[^.!\n]{0,80}(?:отправил|отправила|прислал|прислала|загрузил|загрузила)/iu;

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
const EXCHANGE_UNSUPPORTED_NETWORKS: ReadonlyArray<{ re: RegExp; name: string }> = [
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

function numberLike(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function formatExchangeRateNote(
  amountTo: number,
  amountFrom: number,
  srcAsset: string,
  quoteCode: string,
): string {
  const eff = amountTo / amountFrom; // котируемая валюта за 1 ед. источника
  if (!Number.isFinite(eff) || eff <= 0) return "";
  const r = (n: number) => Math.round(n * 100) / 100;
  // Для фиата (eff < 1) инвертируем в привычный «1 PHP = X RUB». Округляем до 2.
  return eff >= 1
    ? ` (курс 1 ${srcAsset} = ${r(eff)} ${quoteCode})`
    : ` (курс 1 ${quoteCode} = ${r(1 / eff)} ${srcAsset})`;
}

function forcedExchangeQuoteText(
  result: unknown,
  networkAssumed = false,
  showRate = false,
): string | null {
  if (!result || typeof result !== "object") return null;
  const row = result as Record<string, unknown>;
  if (typeof row.error === "string" && row.error.trim()) return row.error.trim();
  const amountToThb = numberLike(row.amountToThb);
  if (amountToThb === null) return null;
  const directionQuote = typeof row.direction === "string" ? row.direction.split("->")[1] : null;
  const currency = resolveQuoteCurrency(
    typeof row.quoteAsset === "string" ? row.quoteAsset : directionQuote,
  );
  // Тёплая, живая формулировка (не сухое «Получите X»). Число/валюта — от
  // compute_quote, поэтому guard пропускает. Исходную сумму повторяем, чтобы
  // она оставалась в истории и LLM на следующих ходах не «терял» её.
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
  // Курс показываем только когда клиент его явно спросил (showRate) — иначе
  // прячем спред. Число курса — из compute_quote (guard пропускает).
  const rateNote =
    showRate && srcAsset && amountFrom !== null && amountFrom > 0
      ? formatExchangeRateNote(amountToThb, amountFrom, srcAsset, currency.code)
      : "";
  return amountFrom !== null && srcAsset
    ? `Готово! Отдаёте ${amountFrom} ${srcAsset}${rateNote} — получите ${amountToThb} ${currency.code} на руки${netNote}.`
    : `Готово — получите ${amountToThb} ${currency.code} на руки${netNote}.`;
}

const EXCHANGE_USDT_RE = /usdt|юсдт/iu;

/**
 * Вопрос о недостающих параметрах ПОСЛЕ котировки: вести к заявке, а не замирать
 * на «Получите X». Спрашиваем: (1) сеть USDT, если клиент не указал — иначе
 * кошелёк уйдёт в дефолтную TRC20, которая может быть не та; (2) способ выдачи.
 * Способ ОПЛАТЫ (СБП/карта) выносим в отдельный шаг (maybeForceExchangePaymentMethodQuestion)
 * — слова «сбп/qr/карта/перевод» + число котировки в одном тексте триггерят
 * requisites-guard → фоллбэк. В отдельном ходу числа нет → guard пропускает.
 * networkKnown/payoutKnown — поля из buildExchangeCollected (#654), не regex.
 */
function exchangeMissingFieldsQuestion(
  asset: string,
  networkKnown: boolean,
  payoutKnown: boolean,
  bankLabel = "местный банковский счёт",
): string | null {
  const parts: string[] = [];
  if (EXCHANGE_USDT_RE.test(asset) && !networkKnown) {
    parts.push("в какой сети будете отправлять USDT — TRC20, ERC20 или BEP20");
  }
  if (!payoutKnown) {
    parts.push(
      `как удобнее получить деньги — наличными в офисе, снятием в банкомате или зачислением на ${bankLabel}`,
    );
  }
  if (parts.length === 0) return null;
  return `Подскажите, ${parts.join(", и ")}?`;
}

async function maybeForceExchangeQuoteReply(input: {
  userMessageText: string;
  tools: AnyRagTool[];
  history: MessageRow[];
  injected?: ExchangeCollectedInput | null;
}): Promise<ExchangeForcedReply | null> {
  if (EXCHANGE_KYC_MATERIAL_SENT_RE.test(input.userMessageText)) return null;
  const quoteTool = input.tools.find((tool) => tool.name === "compute_exchange_quote");
  if (!quoteTool) return null;
  // Аргументы — из универсально собранного (leadFieldValues), не regex (#654).
  const collected = buildExchangeCollected(input.injected);
  if (!collected.asset || !collected.amount) return null;
  // Считаем котировку, только если клиент назвал СВЕЖУЮ сумму этого хода
  // (amountSetThisTurn) или это follow-up «посчитай/пересчитай». «TRC20 в
  // банкомате» при готовой сделке (суммы этого хода нет) → не котировка, а
  // сводка/оплата (#654: сумма берётся из injected, не из истории).
  // Анти-повтор (как в llm-reply, #723): после выданной котировки повторные
  // «сколько/посчитай» НЕ пере-котируют. НО явный вопрос про КУРС (rateAsked)
  // обслуживаем всегда — показываем курс (forcedExchangeQuoteText showRate).
  const rateAsked = EXCHANGE_RATE_QUESTION_RE.test(input.userMessageText);
  const freshAmount =
    input.injected?.amountSetThisTurn === true ||
    (EXCHANGE_QUOTE_FOLLOWUP_RE.test(input.userMessageText) &&
      !hasRecentExchangeQuote(input.history));
  if (!freshAmount && !rateAsked) return null;
  const args: ExchangeQuoteArgs = {
    asset: collected.asset,
    amount: collected.amount,
    amountMode: "source_amount",
    ...(collected.network ? { network: collected.network } : {}),
  };
  const result = await quoteTool.execute(args);
  const text = forcedExchangeQuoteText(result, !args.network, rateAsked);
  if (!text) return null;
  const resultRow = (result ?? {}) as Record<string, unknown>;
  const dirQ = typeof resultRow.direction === "string" ? resultRow.direction.split("->")[1] : null;
  const quoteBankLabel = resolveQuoteCurrency(
    typeof resultRow.quoteAsset === "string" ? resultRow.quoteAsset : dirQ,
  ).bankLabel;
  // После котировки дособираем способ выдачи/сети (если клиент ещё не назвал),
  // чтобы вести к заявке, а не замирать на «Получите X». networkKnown/payoutKnown
  // — из собранного, не regex.
  const ask = exchangeMissingFieldsQuestion(
    collected.asset,
    Boolean(collected.network),
    Boolean(collected.payoutMethod),
    quoteBankLabel,
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

function buildExchangeCollected(injected?: ExchangeCollectedInput | null): ExchangeCollected {
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
  if (asset && EXCHANGE_USDT_RE.test(asset) && !network) missing.push("network");
  if (asset && !payoutMethod) missing.push("payout");
  if (asset === "RUB" && !paymentMethod) missing.push("payment");
  return { asset, amount, network, payoutMethod, paymentMethod, missing };
}

// Метки для сводки/грунтинга. ВАЖНО: формулировки без слов
// оплат*/перевод/карта/qr/сбп/реквизит — иначе текст с числом котировки
// триггерит requisites-guard (см. exchange-reply-guard).
function exchangePayoutLabel(method: string | null, bankLabel = "местный счёт"): string | null {
  switch (method) {
    case "atm":
      return "снятие в банкомате";
    case "office_cash":
      return "наличные в офисе";
    case "courier_cash":
      return "доставка курьером";
    case "thai_bank_transfer":
      return `зачисление на ${bankLabel}`;
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
function renderExchangeSummaryLine(c: ExchangeCollected, quoteResult: unknown): string | null {
  const row = (quoteResult ?? {}) as Record<string, unknown>;
  const amountToThb = numberLike(row.amountToThb);
  if (amountToThb === null || !c.asset || !c.amount) return null;
  const directionQuote = typeof row.direction === "string" ? row.direction.split("->")[1] : null;
  const currency = resolveQuoteCurrency(
    typeof row.quoteAsset === "string" ? row.quoteAsset : directionQuote,
  );
  const net = c.network ? ` (${c.network})` : "";
  const payout = exchangePayoutLabel(c.payoutMethod, currency.bankLabel);
  const payment = c.asset === "RUB" ? exchangePaymentLabel(c.paymentMethod) : null;
  const tail = [payout ? `выдача — ${payout}` : null, payment ? `внесение — ${payment}` : null]
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
  const collected = buildExchangeCollected(input.injected);
  if (collected.asset !== "RUB") return null; // крипта → crypto_transfer авто
  if (collected.paymentMethod) return null; // уже назван
  if (!collected.payoutMethod) return null; // сперва способ выдачи
  if (EXCHANGE_ORDER_CONFIRMATION_RE.test(input.userMessageText)) return null;
  // Не повторяем, если уже спрашивали в последних 4 сообщениях
  const alreadyAsked = input.history
    .slice(-4)
    .some((m) => m.role === "assistant" && m.text.includes("банк-приложении или"));
  if (alreadyAsked) return null;
  return {
    text: "Как удобнее внести рубли — по QR-коду в банк-приложении или банковским переводом со счёта?",
    toolCalls: [],
  };
}

/**
 * Аргументы заявки из универсально собранного (leadFieldValues), не regex (#654).
 * paymentMethod: берём из собранного; иначе дефолт по активу (RUB → bank_transfer,
 * крипта → crypto_transfer).
 */
function exchangeOrderArgsFromCollected(
  injected?: ExchangeCollectedInput | null,
): ExchangeOrderArgs | null {
  const collected = buildExchangeCollected(injected);
  if (!collected.asset || !collected.amount) return null;
  const paymentMethod =
    collected.paymentMethod ?? (collected.asset === "RUB" ? "bank_transfer" : "crypto_transfer");
  return {
    asset: collected.asset,
    amount: collected.amount,
    amountMode: "source_amount",
    ...(collected.network ? { network: collected.network } : {}),
    paymentMethod,
    ...(collected.payoutMethod ? { payoutMethod: collected.payoutMethod } : {}),
  };
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
  injected?: ExchangeCollectedInput | null;
}): Promise<ExchangeForcedReply | null> {
  if (input.state?.stageSlug !== "quote_calculated" && !hasRecentExchangeQuote(input.history)) {
    return null;
  }
  if (!EXCHANGE_ORDER_CONFIRMATION_RE.test(input.userMessageText)) return null;
  if (EXCHANGE_KYC_MATERIAL_SENT_RE.test(input.userMessageText)) return null;
  const createOrderTool = input.tools.find((tool) => tool.name === "create_exchange_order");
  if (!createOrderTool) return null;
  const args = exchangeOrderArgsFromCollected(input.injected);
  if (!args) return null;
  const result = await createOrderTool.execute(args);
  const text = forcedExchangeOrderText(result);
  if (!text) return null;
  const toolCalls: ToolCallRecord[] = [{ name: createOrderTool.name, args, result, cycle: 0 }];
  // Заявка создана успешно — сразу тянем реквизиты, чтобы выдать их в том же
  // сообщении: иначе клиент ждёт «сейчас подготовлю», а заявка протухает по TTL.
  // needsOperator/ошибка реквизитов — оставляем исходный текст (выдаст оператор).
  const orderRow = result as Record<string, unknown> | null;
  if (orderRow && typeof orderRow.orderId === "number" && orderRow.needsVerification !== true) {
    const fetchTool = input.tools.find((tool) => tool.name === "fetch_exchange_requisites");
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
function exchangeSummaryAlreadyShown(history: Array<Pick<MessageRow, "role" | "text">>): boolean {
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
  if (input.state?.stageSlug !== "quote_calculated" && !hasRecentExchangeQuote(input.history)) {
    return null;
  }
  // «да»/«ок» → дальше создаём заявку (maybeForceExchangeOrderReply), не сводку.
  if (EXCHANGE_ORDER_CONFIRMATION_RE.test(input.userMessageText)) return null;
  if (EXCHANGE_KYC_MATERIAL_SENT_RE.test(input.userMessageText)) return null;
  const collected = buildExchangeCollected(input.injected);
  if (collected.missing.length > 0) return null;
  if (!collected.asset || !collected.amount) return null;
  // Сводку не повторяем, если уже показали в текущем эпизоде заявки.
  if (exchangeSummaryAlreadyShown(input.history)) return null;
  const quoteTool = input.tools.find((tool) => tool.name === "compute_exchange_quote");
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

/**
 * #652 — committing-тулзы обмена, которыми AI НЕ должен пользоваться, пока лид
 * припаркован на operator-гейте (awaiting_operator): оформление заявки, выдача
 * реквизитов/выплаты, подтверждение оплаты. Котировку (read-only) оставляем.
 * Forced order/requisites-шаги ищут тул по имени → снятие тула их авто-отключает.
 */
const EXCHANGE_COMMITTING_TOOLS = new Set([
  "create_exchange_order",
  "fetch_exchange_requisites",
  "issue_exchange_payout",
  "verify_exchange_payment",
]);

/** Максимум попыток перегенерации exchange-ответа за один ход (см. цикл в generate). */
const MAX_EXCHANGE_REPLY_ATTEMPTS = 3;

/**
 * Корректирующая подсказка для ПЕРЕгенерации exchange-ответа, который не прошёл
 * (гард переписал выдуманный курс/реквизиты, бот ушёл в отписку «уточню у
 * оператора» ИЛИ ответил в пустоту без контекста). Добавляется к requestContext
 * следующей попытки: цель — заставить ответить по существу (посчитать
 * инструментом / спросить недостающее), а не повторить фабрикацию.
 */
function buildExchangeRetryHint(guarded: {
  reason?: string | null;
  requiredFixes?: readonly string[];
}): string {
  const fixes = guarded.requiredFixes?.length ? guarded.requiredFixes.join(" ") : "";
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
 * Кому нужен оператор? Порядок резолва хэндоффа для exchange-ответа:
 *   1) сигнал из tool-результата/состояния (buildExchangeOperatorHandoff);
 *   2) guard потребовал escalate/block — явный generic с причиной guard'а;
 *   3) исчерпаны попытки перегенерации (retriesExhausted): бот несколько раз
 *      подряд не дал нормальный ответ → оператор. Триггер по СЧЁТЧИКУ неудач,
 *      не по тексту ответа (выбор владельца).
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
 * Перевод canned/forced exchange-реплик на язык диалога (#730 follow-up).
 * Forced-шаги (котировка/способ оплаты/заявка/сводка) и `EXCHANGE_SAFE_FALLBACK` —
 * это русские строки/шаблоны, которые идут МИМО answerWithRag и его языковой
 * директивы, поэтому остаются русскими даже когда диалог на ko/zh/en. Свободный
 * LLM-ответ уже на нужном языке — его НЕ переводим (вызывается только на canned).
 * Гейт `lang≠ru`; перевод fail-safe (ошибка → оригинал, см. translateText).
 */
async function localizeForcedExchangeReply(
  text: string,
  lang: ReplyLang | null | undefined,
  chat: ChatClient,
): Promise<string> {
  if (!lang || lang === "ru") return text;
  return translateText({
    chat,
    text,
    targetLang: lang,
    onWarn: (m) => console.warn(`[rag-reply] forced-reply translate: ${m}`),
  });
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
        if (typeof v === "number" && Number.isFinite(v) && v >= 2) recentWindow = v;
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
          if (typeof g.compactAfterMessages === "number" && g.compactAfterMessages > 0)
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
            ...(style.experimentId !== undefined ? { experimentId: style.experimentId } : {}),
          })
          .catch((err) => console.warn("[rag-reply] failed to save style assignment:", err));
      }
    }

    const isExchange = template?.slug === "exchange_v1";

    const skills = ctx.skills ?? [];
    const directorHooks = ctx.directorHooks ?? [];
    const allTools = ctx.tools ?? [];
    const reranker = ctx.reranker ?? null;
    const stageGuidance = ctx.stageGuidance ?? null;
    const requestContext = ctx.requestContext ?? null;
    const serviceOrderContext = ctx.serviceOrderContext ?? null;
    const awaitingOperator = ctx.awaitingOperator ?? false;
    const exchangePolicyState = isExchange ? (ctx.exchangePolicyState ?? null) : null;
    const exchangeCollected = isExchange ? (ctx.exchangeCollected ?? null) : null;
    // #652 — лид припаркован на operator-гейте (awaiting_operator): в денежном
    // флоу обмена AI НЕ должен сам коммитить заявку/реквизиты/выплату, пока
    // решает оператор (раньше бот сам оформлял заявку, оператора лишь
    // «уведомляли»). Снимаем committing-тулзы — forced-шаги ищут тул по имени и
    // авто-отключаются, котировка/ответы остаются. Mode здесь не трогаем, чтобы
    // «вернуть боту» (#619) не зациклил повторную эскалацию.
    const exchangeOperatorPending = isExchange && awaitingOperator;
    const tools = exchangeOperatorPending
      ? allTools.filter((t) => !EXCHANGE_COMMITTING_TOOLS.has(t.name))
      : allTools;

    const forcedExchangeReply = isExchange
      ? ((await maybeForceExchangeOrderReply({
          userMessageText: input.userMessageText,
          history: historyWithoutCurrent,
          state: exchangePolicyState,
          tools,
          injected: exchangeCollected,
        })) ??
        maybeForceExchangeUnsupportedNetwork({
          userMessageText: input.userMessageText,
        }) ??
        (await maybeForceExchangeQuoteReply({
          userMessageText: input.userMessageText,
          tools,
          history: historyWithoutCurrent,
          injected: exchangeCollected,
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
        (ctx.exchangeResponseGuardEnabled ?? true) ? exchangeGuardFindingFromResult(guarded) : null;
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
          console.warn("[rag-reply] failed to record forced exchange tool call:", err);
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
        // forced-реплики — русские шаблоны мимо языковой директивы → переводим
        // на язык диалога (operatorHandoff остаётся на RU для оператора).
        text: await localizeForcedExchangeReply(guarded.text, ctx.lang, chat),
        operatorHandoff,
        customerNoticeEnabled: ctx.exchangeCustomerNoticeEnabled ?? true,
      });
    }

    // Грунтинг exchange-состояния: что клиент уже назвал (сумма/направление/
    // выдача/оплата). Идёт в промпт — LLM не теряет сумму и не переспрашивает.
    const exchangeGrounding = isExchange
      ? renderExchangeCollectedGrounding(buildExchangeCollected(exchangeCollected))
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
    // Одна попытка генерации; hint (для ретрая) уходит в requestContext.
    const runAnswer = (hint: string | null) => {
      const attemptRequestContext = hint
        ? [combinedRequestContext, hint].filter(Boolean).join("\n\n")
        : combinedRequestContext;
      return answerWithRag({
        question: input.userMessageText,
        kb,
        embedder: ctx.embedder,
        chat: chat as unknown as Parameters<typeof answerWithRag>[0]["chat"],
        history: history as unknown as Parameters<typeof answerWithRag>[0]["history"],
        topK: this.opts.topK ?? 5,
        hybridSearch: this.opts.hybridSearch ?? true,
        rewriteQueryBeforeRetrieval: this.opts.rewriteQueryBeforeRetrieval ?? false,
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
        ...(attemptRequestContext ? { requestContext: attemptRequestContext } : {}),
        ...(serviceOrderGrounding
          ? { vacanciesBlock: serviceOrderGrounding, vacancyGuard: false }
          : {}),
        ...(awaitingOperator ? { awaitingOperator } : {}),
        ...(ctx.lang ? { lang: ctx.lang } : {}),
      });
    };

    const exchangeGuardEnabled = ctx.exchangeResponseGuardEnabled ?? true;
    // Цикл «перегенерировать, пока не нормальный ответ» (выбор владельца, ср.
    // llm-reply): для exchange до MAX_EXCHANGE_REPLY_ATTEMPTS попыток. Плохой
    // ответ — нет контекста / гард переписал выдуманный курс/реквизиты / бот
    // ушёл в отписку «уточню у оператора» → корректирующая подсказка и
    // перегенерация. Все попытки мимо → оператор (по СЧЁТЧИКУ неудач, не по
    // тексту). Жёсткий политблок (escalate/block) НЕ ретраим — сразу оператор.
    // Не-exchange / выключенный guard — одна попытка, как раньше.
    const maxAttempts = isExchange && exchangeGuardEnabled ? MAX_EXCHANGE_REPLY_ATTEMPTS : 1;
    let result = await runAnswer(null);
    let guarded: ReturnType<typeof guardExchangePolicy> = {
      ok: true,
      action: "pass",
      text: result.text,
      reasons: [],
      requiredFixes: [],
    };
    let correctiveHint: string | null = null;
    let retriesExhausted = false;
    let noContext = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) result = await runAnswer(correctiveHint);
      noContext =
        result.text === NO_CONTEXT_MARKER || !result.text || result.text.trim().length === 0;
      if (noContext) {
        console.warn(
          `[exchange-reflect-guard] tenant=${tenantId} conversation=${input.conversationId} path=${result.telemetry.path}`,
        );
        // Нет контекста = плохой ответ: для exchange ретраим (вдруг по подсказке
        // бот спросит недостающее), иначе ниже — softFallback/молчание.
        guarded = {
          ok: false,
          action: "rewrite",
          text: EXCHANGE_SAFE_FALLBACK,
          reasons: [],
          requiredFixes: [],
        };
      } else {
        guarded =
          isExchange && exchangeGuardEnabled
            ? guardExchangePolicy({
                text: result.text,
                telemetry: result.telemetry,
                history: historyWithoutCurrent,
                state: exchangePolicyState,
              })
            : {
                ok: true,
                action: "pass",
                text: result.text,
                reasons: [],
                requiredFixes: [],
              };
        // unbacked_quote: один перезапрос вместо жёсткой заглушки.
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
      }
      if (maxAttempts === 1) break;
      // Жёсткий политблок — сразу оператор, без перегенерации.
      if (guarded.action === "escalate" || guarded.action === "block") break;
      const badAnswer = noContext || !guarded.ok || guarded.text.trim() === EXCHANGE_SAFE_FALLBACK;
      if (!badAnswer) break;
      if (attempt >= maxAttempts) {
        retriesExhausted = true;
        break;
      }
      correctiveHint = buildExchangeRetryHint(guarded);
    }

    // Нет контекста (итог попыток): лог незакрытого вопроса; для НЕ-exchange —
    // softFallback/молчание, как раньше. Для exchange guarded уже =
    // safe-fallback, эскалацию решит retriesExhausted ниже.
    if (noContext) {
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
      if (!isExchange) {
        if (!this.opts.softFallback) return null;
        // Derive persona: from style (if set) or DEFAULT_PERSONA.
        const persona: Persona = style
          ? {
              name: style.persona.name,
              role: style.persona.role,
              ...(style.persona.company?.trim() ? { company: style.persona.company.trim() } : {}),
            }
          : DEFAULT_PERSONA;
        const fallbackText = await generateSoftFallback({
          question: input.userMessageText,
          chat: chat as unknown as Parameters<typeof generateSoftFallback>[0]["chat"],
          persona,
          history: history as unknown as Parameters<typeof generateSoftFallback>[0]["history"],
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
    }
    const guardFinding =
      isExchange && exchangeGuardEnabled ? exchangeGuardFindingFromResult(guarded) : null;
    if (!guarded.ok) {
      console.warn(
        `[exchange-policy-guard] tenant=${tenantId} conversation=${input.conversationId} reason=${guarded.reason ?? "unknown"}`,
      );
    }

    if (
      this.opts.recordToolCalls &&
      ((result.telemetry.toolCalls?.length ?? 0) > 0 || result.telemetry.toolCall || guardFinding)
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
      ? resolveExchangeOperatorHandoff({
          text: guarded.text,
          action: guarded.action,
          reason: guarded.reason ?? null,
          telemetry: result.telemetry,
          state: exchangePolicyState,
          retriesExhausted,
        })
      : null;

    // Свободный LLM-ответ уже на языке диалога (директива в composeSystemPrompt).
    // Переводим ТОЛЬКО canned-подстановку guard'а (EXCHANGE_SAFE_FALLBACK) — она
    // русская и идёт мимо директивы. LLM-текст не трогаем (иначе двойной перевод).
    const customerText =
      isExchange && guarded.text.trim() === EXCHANGE_SAFE_FALLBACK
        ? await localizeForcedExchangeReply(guarded.text, ctx.lang, chat)
        : guarded.text;

    return isExchange
      ? exchangeReplyOutput({
          channelId: input.channel.channelId,
          externalUserId: input.inbound.externalUserId,
          text: customerText,
          operatorHandoff,
          customerNoticeEnabled: ctx.exchangeCustomerNoticeEnabled ?? true,
        })
      : [
          {
            channelId: String(input.channel.channelId),
            externalUserId: input.inbound.externalUserId,
            parts: [{ kind: "text", text: customerText }],
          },
        ];
  }
}
