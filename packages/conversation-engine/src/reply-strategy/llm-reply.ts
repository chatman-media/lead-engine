import type { OutboundEnvelope } from "@chatman-media/channel-core";
import {
	type AnswerTelemetry,
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
	buildExchangeAnswerQualityContext,
	exchangeOperatorHandoffForContext,
	logExchangeAnswerQualityTrace,
} from "./exchange-answer-quality.ts";
import {
	type ExchangePolicyState,
	guardExchangePolicy,
} from "./exchange-policy-guard.ts";
import { EXCHANGE_SAFE_FALLBACK } from "./exchange-reply-guard.ts";

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
	template: VerticalTemplate;
	/** Optional tenant-specific template resolver. Falls back to `template`. */
	resolveTemplate?: (tenantId: number) => VerticalTemplate | undefined;
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
	/** Optional real exchange state snapshot used by the final policy guard. */
	resolveExchangePolicyState?: (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
	}) => Promise<ExchangePolicyState | null> | ExchangePolicyState | null;
	/**
	 * Optional post-generation recorder for agentic tool traces. Called only
	 * when this strategy executed one or more tools, including deterministic
	 * exchange shortcuts and generic tool-loop calls.
	 */
	recordToolCalls?: (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
		userMessageText: string;
		assistantText: string;
		telemetry: Pick<AnswerTelemetry, "toolCall" | "toolCalls">;
	}) => Promise<void> | void;
}

const BASE_SYSTEM_PROMPT =
	"Ты — операционный бот платформы lead-engine. Отвечай кратко, " +
	"уважительно, по делу. Никогда не выдумывай факты которых нет в " +
	"контексте — лучше скажи «уточню у партнёра» и поставь сообщение в очередь оператора.";

const CRYPTO_ASSETS = new Set(["USDT", "BTC", "ETH"]);

interface ExchangeQuoteArgs {
	asset: string;
	amount: number;
	amountMode: "source_amount" | "target_thb";
	network?: string;
}

function cleanNumber(raw: string): number {
	const normalized = raw.replace(/\s+/g, "").replace(",", ".");
	return Number(normalized);
}

function parseExchangeQuoteArgs(text: string): ExchangeQuoteArgs | null {
	const upper = text.toUpperCase();
	const asset =
		upper.match(/\b(USDT|BTC|ETH|RUB|USD|EUR)\b/u)?.[1] ??
		(/руб|₽/iu.test(text) ? "RUB" : null);
	if (!asset) return null;

	const amountRe =
		asset === "RUB"
			? /(\d+(?:[\s.]\d{3})*(?:[,.]\d+)?)\s*(?:RUB|руб|₽)/iu
			: new RegExp(`(\\d+(?:[\\s.]\\d{3})*(?:[,.]\\d+)?)\\s*${asset}`, "iu");
	const amountMatch =
		text.match(amountRe) ?? text.match(/(\d+(?:[\s.]\d{3})*(?:[,.]\d+)?)/u);
	if (!amountMatch?.[1]) return null;
	const amount = cleanNumber(amountMatch[1]);
	if (!(amount > 0)) return null;

	const network = upper.match(/\b(TRC20|ERC20|BEP20)\b/u)?.[1];
	return {
		asset,
		amount,
		amountMode: /(?:получить|нужно|надо)\s+\d[\d\s.,]*\s*(?:THB|бат)/iu.test(
			text,
		)
			? "target_thb"
			: "source_amount",
		...(network ? { network } : {}),
	};
}

function latestQuoteArgs(
	history: MessageRow[],
	currentText: string,
): ExchangeQuoteArgs | null {
	const candidates = [
		currentText,
		...[...history].reverse().map((m) => m.text),
	];
	let first: ExchangeQuoteArgs | null = null;
	for (const text of candidates) {
		const parsed = parseExchangeQuoteArgs(text);
		if (!parsed) continue;
		if (parsed.network) return parsed;
		first ??= parsed;
	}
	if (!first) return null;
	const network = candidates
		.join("\n")
		.toUpperCase()
		.match(/\b(TRC20|ERC20|BEP20)\b/u)?.[1];
	return network ? { ...first, network } : first;
}

function asksForQuote(text: string, hasQuoteContext = false): boolean {
	if (isConfirmation(text)) return false;
	const asksAmount =
		/(?:курс|сколько|итог|получ(?:у|ить|ится|аю)|на\s+руки|точн(?:ая|ую)?\s+цифр|посчитай|рассчитай)/iu.test(
			text,
		);
	if (!asksAmount) return false;
	return (
		hasQuoteContext || /(?:USDT|BTC|ETH|RUB|USD|EUR|руб|₽|бат|THB)/iu.test(text)
	);
}

function isRateObjection(text: string): boolean {
	return /(?:мало|не\s+очень|невыгодн|выгодн(?:ее|ей)|дорог|лучше|хуже|скидк|торг|курс\s+(?:низк|плох)|у\s+других|предлагаете|правильно|верно|то\s+есть)/iu.test(
		text,
	);
}

function isFeeQuestion(text: string): boolean {
	return /(?:комисс|вычет|чист(?:ая|ую|ыми?)|финальн|конечн|дополнительн|без\s+доп|уже\s+с|после\s+всех|на\s+сч[её]т)/iu.test(
		text,
	);
}

function isConfirmation(text: string): boolean {
	return /(?:подтверждаю|согласен|согласна|готов|готова|да,\s*оформ|оформляйте|давайте|курс\s+подходит)/iu.test(
		text,
	);
}

function hasPriorQuote(history: MessageRow[]): boolean {
	return history.some(
		(m) =>
			m.role === "assistant" &&
			/(?:курс|получа(?:ете|ешь)|отда[её]те|THB|бат)/iu.test(m.text) &&
			/(?:подтверждаю|оформлю заявку|если курс подходит)/iu.test(m.text),
	);
}

function formatQuote(result: unknown): string | null {
	if (typeof result !== "object" || result === null) return null;
	const r = result as Record<string, unknown>;
	if (typeof r.error === "string") return EXCHANGE_SAFE_FALLBACK;
	const asset = typeof r.asset === "string" ? r.asset : "USDT";
	const rate = r.rate;
	const amountFrom = r.amountFrom;
	const amountToThb = r.amountToThb;
	if (rate == null || amountFrom == null || amountToThb == null) return null;
	return [
		`Обмен ${asset} — THB`,
		`Курс: ${rate}`,
		"",
		`Отдаёте: ${amountFrom} ${asset}`,
		`Получаете: ${amountToThb} THB`,
		"",
		"Если курс подходит, напишите «подтверждаю», и я оформлю заявку.",
	].join("\n");
}

function formatRateObjection(result: unknown): string | null {
	if (typeof result !== "object" || result === null) return null;
	const r = result as Record<string, unknown>;
	if (typeof r.error === "string") return EXCHANGE_SAFE_FALLBACK;
	const asset = typeof r.asset === "string" ? r.asset : "USDT";
	const rate = r.rate;
	const amountFrom = r.amountFrom;
	const amountToThb = r.amountToThb;
	if (rate == null || amountFrom == null || amountToThb == null) return null;
	return [
		`Да. Сейчас по системе для ${amountFrom} ${asset} курс ${rate}, итог к получению — ${amountToThb} THB.`,
		"Курс фиксируется по расчёту, вручную в чате я его не меняю.",
		"Если курс подходит — напишите «подтверждаю». Если нужен индивидуальный курс на объём, передам оператору.",
	].join("\n\n");
}

function formatFeeReply(result: unknown): string | null {
	if (typeof result !== "object" || result === null) return null;
	const r = result as Record<string, unknown>;
	if (typeof r.error === "string") return EXCHANGE_SAFE_FALLBACK;
	const asset = typeof r.asset === "string" ? r.asset : "USDT";
	const amountToThb = r.amountToThb;
	const amountFrom = r.amountFrom;
	if (amountToThb == null || amountFrom == null) return null;
	const feeLine = CRYPTO_ASSETS.has(asset)
		? `Сетевой сбор за отправку ${asset} покрывает отправитель отдельно; из суммы THB к получению он не вычитается.`
		: "Сбор вашего банка/платёжного сервиса покрывает отправитель отдельно; из суммы THB к получению он не вычитается.";
	return [
		`${amountToThb} THB — это сумма к выдаче по нашей стороне за ${amountFrom} ${asset}.`,
		"Дополнительной комиссии обменника поверх этой суммы нет.",
		feeLine,
		"Если всё подходит, напишите «подтверждаю», и я оформлю заявку.",
	].join("\n\n");
}

function inferPayoutMethod(text: string): string {
	if (/(?:тайск|банк|сч[её]т|карта)/iu.test(text)) return "thai_bank_transfer";
	if (/(?:банкомат|atm|cardless|без\s+карты)/iu.test(text))
		return "cardless_atm";
	if (/(?:курьер|достав)/iu.test(text)) return "courier_cash";
	return "office_cash";
}

function formatCreateOrder(result: unknown): string | null {
	if (typeof result !== "object" || result === null) return null;
	const r = result as Record<string, unknown>;
	if (typeof r.error === "string") return r.error;
	if (r.needsVerification === true) {
		const instructions =
			typeof r.instructions === "string"
				? r.instructions
				: "Для обмена нужно пройти верификацию: пришлите документ и короткое видео/кружок с ФИО.";
		return `${instructions}\n\nПосле проверки продолжим оформление заявки и выдадим реквизиты.`;
	}
	if (r.orderId != null) {
		return [
			`Заявка #${r.orderId} создана.`,
			r.amountToThb != null ? `Сумма к получению: ${r.amountToThb} THB.` : null,
			"Сейчас подготовлю реквизиты для оплаты.",
		]
			.filter(Boolean)
			.join("\n");
	}
	return null;
}

async function runNamedTool(
	tools: AnyRagTool[],
	name: string,
	args: Record<string, unknown>,
): Promise<{ result: unknown; record: ToolCallRecord } | null> {
	const tool = tools.find((t) => t.name === name);
	if (!tool) return null;
	try {
		const result = await tool.execute(args);
		return { result, record: { name, args, result, cycle: 0 } };
	} catch (err) {
		const result = { error: err instanceof Error ? err.message : String(err) };
		return { result, record: { name, args, result, error: true, cycle: 0 } };
	}
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

		const recordToolCalls = async (
			assistantText: string,
			records: readonly ToolCallRecord[],
		) => {
			if (!this.opts.recordToolCalls || records.length === 0) return;
			const telemetry = buildToolTelemetry([...records]);
			await Promise.resolve(
				this.opts.recordToolCalls({
					tenantId: input.tenant.tenantId,
					conversationId: input.conversationId,
					contactId: input.contactId,
					userMessageText: input.userMessageText,
					assistantText,
					telemetry,
				}),
			).catch((err) =>
				console.warn("[llm-reply] failed to record tool calls:", err),
			);
		};

		const messages = this.messagesRepoFor(input.tenant.tenantId);
		const history = await messages.recent(
			input.conversationId,
			this.opts.historyLimit ?? 20,
		);
		const historyMessages = messagesToChatHistory(history);

		const chat = this.opts.resolveChat(input.tenant.tenantId);
		const template =
			this.opts.resolveTemplate?.(input.tenant.tenantId) ?? this.opts.template;
		const isExchange = template.slug === "exchange_v1";
		const llmOpts = {
			temperature: this.opts.temperature ?? 0.7,
			numPredict: this.opts.maxOutputTokens ?? 600,
		};
		const exchangePolicyState =
			isExchange && this.opts.resolveExchangePolicyState
				? await Promise.resolve(
						this.opts.resolveExchangePolicyState({
							tenantId: input.tenant.tenantId,
							conversationId: input.conversationId,
							contactId: input.contactId,
						}),
					).catch(() => null)
				: null;
		const exchangeQuality = isExchange
			? buildExchangeAnswerQualityContext({
					state: exchangePolicyState,
					history,
					userMessageText: input.userMessageText,
				})
			: null;
		if (exchangeQuality) {
			logExchangeAnswerQualityTrace({
				tenantId: input.tenant.tenantId,
				conversationId: input.conversationId,
				path: "llm",
				context: exchangeQuality,
			});
		}
		const logExchangeGuardBlock = (
			guarded: ReturnType<typeof guardExchangePolicy>,
		) => {
			if (!exchangeQuality || guarded.ok) return;
			logExchangeAnswerQualityTrace({
				tenantId: input.tenant.tenantId,
				conversationId: input.conversationId,
				path: "llm",
				context: exchangeQuality,
				guard: guarded,
				event: "guard",
			});
			console.warn(
				`[exchange-policy-guard] tenant=${input.tenant.tenantId} conversation=${input.conversationId} reason=${guarded.reason ?? "unknown"} fallback=${guarded.text}`,
			);
		};
		if (exchangeQuality?.deterministicReply) {
			const guardedDeterministic = guardExchangePolicy({
				text: exchangeQuality.deterministicReply,
				history,
				state: exchangePolicyState,
			});
			logExchangeGuardBlock(guardedDeterministic);
			const operatorHandoff =
				exchangeOperatorHandoffForContext(exchangeQuality);
			return [
				{
					channelId: String(input.channel.channelId),
					externalUserId: input.inbound.externalUserId,
					parts: [{ kind: "text", text: guardedDeterministic.text }],
					...(operatorHandoff ? { operatorHandoff } : {}),
				},
			];
		}

		// Agentic-инструменты (если есть и клиент их умеет): даёт боту считать
		// курс/сумму tool-call'ом вместо «уточню у партнёра», даже без RAG.
		let tools: AnyRagTool[] = [];
		if (this.opts.resolveTools) {
			try {
				tools = await this.opts.resolveTools({
					tenantId: input.tenant.tenantId,
					conversationId: input.conversationId,
					contactId: input.contactId,
				});
			} catch {
				tools = [];
			}
		}
		const toolsActive =
			tools.length > 0 && typeof chat.completeWithTools === "function";

		if (isExchange && tools.length > 0) {
			const quoteArgs = latestQuoteArgs(history, input.userMessageText);
			if (
				quoteArgs &&
				isConfirmation(input.userMessageText) &&
				hasPriorQuote(history)
			) {
				const created = await runNamedTool(tools, "create_exchange_order", {
					asset: quoteArgs.asset,
					amount: quoteArgs.amount,
					amountMode: quoteArgs.amountMode,
					...(quoteArgs.network ? { network: quoteArgs.network } : {}),
					paymentMethod: CRYPTO_ASSETS.has(quoteArgs.asset)
						? "crypto_transfer"
						: "card_transfer",
					paymentRail: quoteArgs.network?.toLowerCase(),
					payoutMethod: inferPayoutMethod(input.userMessageText),
				});
				const text = created ? formatCreateOrder(created.result) : null;
				if (created && text) {
					const createRecords = [created.record];
					const guardedCreate = guardExchangePolicy({
						text,
						history,
						state: exchangePolicyState,
						telemetry: buildToolTelemetry(createRecords),
					});
					logExchangeGuardBlock(guardedCreate);
					await recordToolCalls(guardedCreate.text, createRecords);
					return [
						{
							channelId: String(input.channel.channelId),
							externalUserId: input.inbound.externalUserId,
							parts: [{ kind: "text", text: guardedCreate.text }],
						},
					];
				}
			}

			if (
				quoteArgs &&
				hasPriorQuote(history) &&
				isFeeQuestion(input.userMessageText)
			) {
				const quoted = await runNamedTool(tools, "compute_exchange_quote", {
					...quoteArgs,
				});
				const text = quoted ? formatFeeReply(quoted.result) : null;
				if (quoted && text) {
					const feeRecords = [quoted.record];
					const guardedFee = guardExchangePolicy({
						text,
						history,
						state: exchangePolicyState,
						telemetry: buildToolTelemetry(feeRecords),
					});
					logExchangeGuardBlock(guardedFee);
					await recordToolCalls(guardedFee.text, feeRecords);
					return [
						{
							channelId: String(input.channel.channelId),
							externalUserId: input.inbound.externalUserId,
							parts: [{ kind: "text", text: guardedFee.text }],
						},
					];
				}
			}

			if (
				quoteArgs &&
				hasPriorQuote(history) &&
				isRateObjection(input.userMessageText)
			) {
				const quoted = await runNamedTool(tools, "compute_exchange_quote", {
					...quoteArgs,
				});
				const text = quoted ? formatRateObjection(quoted.result) : null;
				if (quoted && text) {
					const objectionRecords = [quoted.record];
					const guardedObjection = guardExchangePolicy({
						text,
						history,
						state: exchangePolicyState,
						telemetry: buildToolTelemetry(objectionRecords),
					});
					logExchangeGuardBlock(guardedObjection);
					await recordToolCalls(guardedObjection.text, objectionRecords);
					return [
						{
							channelId: String(input.channel.channelId),
							externalUserId: input.inbound.externalUserId,
							parts: [{ kind: "text", text: guardedObjection.text }],
						},
					];
				}
			}

			if (
				quoteArgs &&
				asksForQuote(input.userMessageText, hasPriorQuote(history))
			) {
				const quoted = await runNamedTool(tools, "compute_exchange_quote", {
					...quoteArgs,
				});
				const text = quoted ? formatQuote(quoted.result) : null;
				if (quoted && text) {
					const quoteRecords = [quoted.record];
					const guardedQuote = guardExchangePolicy({
						text,
						history,
						state: exchangePolicyState,
						telemetry: buildToolTelemetry(quoteRecords),
					});
					logExchangeGuardBlock(guardedQuote);
					await recordToolCalls(guardedQuote.text, quoteRecords);
					return [
						{
							channelId: String(input.channel.channelId),
							externalUserId: input.inbound.externalUserId,
							parts: [{ kind: "text", text: guardedQuote.text }],
						},
					];
				}
			}
		}

		if (this.opts.resolveIsSupport) {
			const isSupport = await this.opts.resolveIsSupport({
				tenantId: input.tenant.tenantId,
				contactId: input.contactId,
			});
			if (isSupport) return null;
		}

		const serviceOrderContext = this.opts.resolveServiceOrderContext
			? await Promise.resolve(
					this.opts.resolveServiceOrderContext({
						tenantId: input.tenant.tenantId,
						conversationId: input.conversationId,
						contactId: input.contactId,
					}),
				).catch(() => null)
			: null;

		const systemPrompt = [
			BASE_SYSTEM_PROMPT,
			toolsActive
				? "Если для ответа есть подходящий инструмент (например, расчёт курса обмена) — " +
					"ОБЯЗАТЕЛЬНО вызови его и дай конкретные числа. Не отсылай к оператору, если можешь " +
					"ответить инструментом."
				: "",
			exchangeQuality?.statePack,
			serviceOrderContext,
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
					history,
					state: exchangePolicyState,
					telemetry: buildToolTelemetry(toolCalls),
				})
			: { ok: true, text: reply };
		logExchangeGuardBlock(guarded);
		await recordToolCalls(guarded.text, toolCalls);
		return [
			{
				channelId: String(input.channel.channelId),
				externalUserId: input.inbound.externalUserId,
				parts: [{ kind: "text", text: guarded.text }],
			},
		];
	}
}
