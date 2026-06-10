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
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
import type { ReplyStrategy } from "../process-inbound.ts";
import {
  LLM_REPLY_BASE_SYSTEM_PROMPT,
  LLM_REPLY_TOOLS_SYSTEM_FRAGMENT,
} from "../prompts/llm-reply.ts";
import {
  type ExchangePolicyState,
  guardExchangePolicy,
} from "./exchange-policy-guard.ts";

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
 *   - conversation summarization для длинных history
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
   * Лимит сообщений в history-prompt'е. Default 20.
   * При больших значениях нужен conversation summary (следующая итерация).
   */
  historyLimit?: number;
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
  resolveIsSupport?: (input: { tenantId: number; contactId: number }) => Promise<boolean>;
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
  }) => Promise<void> | void;
}

function messagesToChatHistory(history: MessageRow[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant" || m.role === "human")
      out.push({ role: "assistant", content: m.text });
    // 'system' уже отфильтрован в MessagesRepo.recent.
  }
  return out;
}

type ExchangeQuoteArgs = {
  asset: string;
  amount: number;
  network?: string;
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
const EXCHANGE_OUTPUT_CURRENCY_RE = /thb|бат|฿/i;
const EXCHANGE_CONFIRMATION_RE = /точно|верно|правильно/i;
const EXCHANGE_KYC_TOPIC_RE = /верификац|kyc|документ|паспорт|видео|кружок/i;
const EXCHANGE_KYC_MATERIAL_SENT_RE =
  /(?:отправил|отправила|прислал|прислала|загрузил|загрузила|вот|держи|лови)[^.!\n]{0,80}(?:видео|кружок|документ|паспорт)|(?:видео|кружок|документ|паспорт)[^.!\n]{0,80}(?:отправил|отправила|прислал|прислала|загрузил|загрузила)/i;
const EXCHANGE_KYC_HANDOFF_TEXT = [
  "Да. Перед реквизитами нужна верификация клиента.",
  "Пришлите короткое видео: лицо и документ в кадре. Оператор или внешний сервис проведёт проверку личности.",
  "После проверки продолжим заявку: способ получения батов, реквизиты и финальное подтверждение.",
].join("\n");

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
      return /\busd\b|доллар/i;
    default:
      return new RegExp(`\\b${asset}\\b`, "i");
  }
}

function amountCandidates(text: string, asset: string): AmountCandidate[] {
  const assetRe = assetMentionRe(asset);
  const matches = [...text.matchAll(/\d+(?:[ \u00a0]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g)];
  const candidates: AmountCandidate[] = [];
  for (const match of matches) {
    const raw = match[0];
    const start = match.index ?? 0;
    const end = start + raw.length;
    const before = text.slice(Math.max(0, start - 16), start).toLowerCase();
    if (/trc\s*$|erc\s*$|bep\s*$/i.test(before)) continue;
    const after = text.slice(end, end + 16).toLowerCase();
    const n = Number(raw.replace(/[ \u00a0]/g, "").replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) continue;

    let score = 0;
    const multiplier = /тыс|к\b|k\b/.test(after) ? 1000 : 1;
    const window = `${before}${raw}${after}`;
    if (assetRe.test(window)) score += 5;
    if (/(?:^|\s)за\s*$/iu.test(before) || /\bза\b/iu.test(before)) score += 2;
    if (/(?:thb|бат|฿)/iu.test(after) && asset !== "THB") score -= 4;
    candidates.push({ amount: n * multiplier, start, score });
  }
  return candidates;
}

function hasExchangeStartIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("обмен") || lower.includes("помен");
}

function parseExchangeQuoteArgs(text: string): ExchangeQuoteArgs | null {
  const quoteIntent = EXCHANGE_QUOTE_INTENT_RE.test(text);
  const confirmationIntent =
    EXCHANGE_CONFIRMATION_RE.test(text) && EXCHANGE_OUTPUT_CURRENCY_RE.test(text);
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
  const asset =
    /\busdt\b|юсдт/.test(lower)
      ? "USDT"
      : /\bbtc\b|битк/.test(lower)
        ? "BTC"
        : /\beth\b|эфир/.test(lower)
          ? "ETH"
          : /\brub\b|руб|₽/.test(lower)
            ? "RUB"
            : /\beur\b|евро/.test(lower)
              ? "EUR"
              : /\busd\b|доллар/.test(lower)
                ? "USD"
                : null;
  if (!asset) return null;

  const candidates = amountCandidates(text, asset);
  const best = candidates.sort((a, b) => b.score - a.score || a.start - b.start)[0];
  if (!best) return null;

  const network =
    /trc[\s-]?20|tron/i.test(text)
      ? "TRC20"
      : /erc[\s-]?20/i.test(text)
        ? "ERC20"
        : /bep[\s-]?20|bsc/i.test(text)
        ? "BEP20"
        : undefined;
  return { asset, amount: best.amount, ...(network ? { network } : {}) };
}

function numberLike(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function forcedExchangeQuoteText(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const row = result as Record<string, unknown>;
  if (typeof row.error === "string") return row.error;
  const asset = typeof row.asset === "string" ? row.asset : null;
  const rate = numberLike(row.rate);
  const amountFrom = numberLike(row.amountFrom);
  const amountToThb = numberLike(row.amountToThb);
  const network = typeof row.network === "string" && row.network ? row.network : null;
  if (!asset || rate === null || amountFrom === null || amountToThb === null) return null;
  const networkLabel = network ? ` (${network})` : "";
  return [
    `Курс: ${rate}.`,
    `За ${amountFrom} ${asset}${networkLabel} получите ${amountToThb} THB.`,
    "Если подходит, напишите, как хотите получить баты: офис, банкомат, курьер или тайский банк.",
  ].join("\n");
}

async function maybeForceExchangeQuoteReply(
  userMessageText: string,
  tools: AnyRagTool[],
): Promise<ExchangeForcedReply | null> {
  const quoteTool = tools.find((tool) => tool.name === "compute_exchange_quote");
  if (!quoteTool) return null;
  const args = parseExchangeQuoteArgs(userMessageText);
  if (!args) return null;
  const result = await quoteTool.execute(args);
  const text = forcedExchangeQuoteText(result);
  if (!text) return null;
  return {
    text,
    toolCalls: [{ name: quoteTool.name, args, result, cycle: 0 }],
  };
}

function maybeForceExchangeKycReply(userMessageText: string): ExchangeForcedReply | null {
  if (!EXCHANGE_KYC_TOPIC_RE.test(userMessageText)) return null;
  if (EXCHANGE_KYC_MATERIAL_SENT_RE.test(userMessageText)) return null;
  return { text: EXCHANGE_KYC_HANDOFF_TEXT, toolCalls: [] };
}

export class LlmReplyStrategy implements ReplyStrategy {
  constructor(
    private readonly opts: LlmReplyStrategyOpts,
    private readonly messagesRepoFor: (tenantId: number) => MessagesRepo,
  ) {}

  async generate(input: {
    tenant: { tenantId: number };
    channel: { channelId: number };
    conversationId: number;
    contactId: number;
    inbound: { externalUserId: string };
    userMessageText: string;
  }): Promise<OutboundEnvelope[] | null> {
    if (input.userMessageText.length === 0) return null;
    const tenantId = input.tenant.tenantId;
    const template = this.opts.resolveTemplate?.(tenantId) ?? this.opts.template;

    if (this.opts.resolveIsSupport) {
      const isSupport = await this.opts.resolveIsSupport({
        tenantId,
        contactId: input.contactId,
      });
      if (isSupport) return null;
    }

    const messages = this.messagesRepoFor(tenantId);
    const history = await messages.recent(input.conversationId, this.opts.historyLimit ?? 20);
    const historyMessages = messagesToChatHistory(history);

    const chat = this.opts.resolveChat(tenantId);
    const llmOpts = {
      temperature: this.opts.temperature ?? 0.7,
      numPredict: this.opts.maxOutputTokens ?? 600,
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
    const toolsActive = tools.length > 0 && typeof chat.completeWithTools === "function";
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
    const forcedExchangeReply = isExchange
      ? ((await maybeForceExchangeQuoteReply(input.userMessageText, tools)) ??
        maybeForceExchangeKycReply(input.userMessageText))
      : null;
    const exchangePolicyState =
      isExchange && this.opts.resolveExchangePolicyState
        ? await Promise.resolve(
            this.opts.resolveExchangePolicyState({
              tenantId,
              conversationId: input.conversationId,
              contactId: input.contactId,
            }),
          ).catch((err) => {
            console.warn("[llm-reply] failed to resolve exchange policy state:", err);
            return null;
          })
      : null;

    if (forcedExchangeReply) {
      const guarded = guardExchangePolicy({
        text: forcedExchangeReply.text,
        telemetry: buildToolTelemetry(forcedExchangeReply.toolCalls),
        history,
        state: exchangePolicyState,
      });
      if (this.opts.recordToolCalls && forcedExchangeReply.toolCalls.length > 0) {
        try {
          await this.opts.recordToolCalls({
            tenantId,
            conversationId: input.conversationId,
            contactId: input.contactId,
            userMessageText: input.userMessageText,
            assistantText: guarded.text,
            toolCalls: forcedExchangeReply.toolCalls,
          });
        } catch (err) {
          console.warn("[llm-reply] failed to record forced exchange tool call:", err);
        }
      }
      return [
        {
          channelId: String(input.channel.channelId),
          externalUserId: input.inbound.externalUserId,
          parts: [{ kind: "text", text: guarded.text }],
        },
      ];
    }

    const systemPrompt = [
      LLM_REPLY_BASE_SYSTEM_PROMPT,
      toolsActive ? LLM_REPLY_TOOLS_SYSTEM_FRAGMENT : "",
      serviceOrderContext?.trim(),
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
    const guarded = isExchange
      ? guardExchangePolicy({
          text: reply,
          telemetry: buildToolTelemetry(toolCalls),
          history,
          state: exchangePolicyState,
        })
      : { ok: true, text: reply };
    if (!guarded.ok) {
      console.warn(
        `[exchange-policy-guard] tenant=${tenantId} conversation=${input.conversationId} reason=${guarded.reason ?? "unknown"}`,
      );
    }
    if (this.opts.recordToolCalls && toolCalls.length > 0) {
      try {
        await this.opts.recordToolCalls({
          tenantId,
          conversationId: input.conversationId,
          contactId: input.contactId,
          userMessageText: input.userMessageText,
          assistantText: guarded.text,
          toolCalls,
        });
      } catch (err) {
        console.warn("[llm-reply] failed to record tool calls:", err);
      }
    }
    return [
      {
        channelId: String(input.channel.channelId),
        externalUserId: input.inbound.externalUserId,
        parts: [{ kind: "text", text: guarded.text }],
      },
    ];
  }
}
