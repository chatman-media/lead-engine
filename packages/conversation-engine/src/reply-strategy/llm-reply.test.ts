import { describe, expect, it } from "bun:test";
import { type AnyRagTool, makeBookingLinkTool } from "@chatman-media/kb";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
import { normalizeReplyStrategyResult } from "../process-inbound.ts";
import { EXCHANGE_KYC_FALLBACK } from "./exchange-policy-guard.ts";
import { EXCHANGE_SAFE_FALLBACK } from "./exchange-reply-guard.ts";
import { LlmReplyStrategy, type LlmReplyStrategyOpts } from "./llm-reply.ts";

const TEMPLATE: VerticalTemplate = {
  slug: "test_v1",
  displayName: "Test",
  version: 1,
  funnelStages: [{ slug: "intake", kind: "intake", displayName: "Intake" }],
  systemPromptFragment: "Ты — тестовый бот вертикали.",
};

const EXCHANGE_TEMPLATE: VerticalTemplate = {
  ...TEMPLATE,
  slug: "exchange_v1",
};

function firstReplyText(result: Awaited<ReturnType<LlmReplyStrategy["generate"]>>): string {
	const normalized = normalizeReplyStrategyResult(result);
	const part = normalized?.envelopes[0]?.parts[0];
	return part?.kind === "text" ? part.text : "";
}

class CapturingChat implements ChatClient {
  lastCall: { messages: ChatMessage[]; opts: unknown } | null = null;
  constructor(public readonly reply: string) {}
  async complete(messages: ChatMessage[], opts?: unknown): Promise<string> {
    this.lastCall = { messages, opts };
    return this.reply;
  }
}

class ToolLoopChat implements ChatClient {
  calls = 0;
  async complete(): Promise<string> {
    return "Вот ссылка для записи: https://calendly.example/demo";
  }
  async completeWithTools(): Promise<{
    content: string | null;
		toolCalls: Array<{
			id: string;
			name: string;
			args: Record<string, unknown>;
		}>;
  }> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: "q1",
            name: "offer_booking_link",
            args: {},
          },
        ],
      };
    }
		return {
			content: "Вот ссылка для записи: https://calendly.example/demo",
			toolCalls: [],
		};
  }
}

class SequencedChat implements ChatClient {
  calls: ChatMessage[][] = [];
  constructor(private readonly replies: string[]) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages);
    return this.replies.shift() ?? "";
  }
}

function fakeMessagesRepo(history: MessageRow[]) {
  return {
    recent: async (_conversationId: number, limit: number) => history.slice(-limit),
    countByConversation: async () => history.length,
    forConversationSummary: async (
      _conversationId: number,
      opts: {
        afterMessageId?: number | null;
        beforeMessageId: number;
        limit: number;
      },
    ) =>
      history
        .filter(
          (item) =>
            item.id < opts.beforeMessageId &&
            (opts.afterMessageId == null || item.id > opts.afterMessageId) &&
            item.deletedAt == null &&
            item.role !== "system",
        )
        .slice(0, opts.limit),
  } as unknown as MessagesRepo;
}

function row(
  id: number,
  role: "user" | "assistant" | "human" | "system",
  text: string,
): MessageRow {
  return {
    id,
    tenantId: 1,
    conversationId: 100,
    role,
    text,
    tgMessageId: null,
    metaJson: null,
    createdAt: 1700000000 + id,
    stage: null,
    deletedAt: null,
  };
}

function exchangeQuoteTool(): AnyRagTool {
  return {
    name: "compute_exchange_quote",
    description: "Compute exchange quote",
    parameters: {} as AnyRagTool["parameters"],
    execute: async (args: Record<string, unknown>) => ({
      direction: `${args.asset}->THB`,
      asset: args.asset,
      network: args.network ?? "TRC20",
      amountMode: "source_amount",
      amountFrom: args.amount,
      rate: 31.5,
      amountToThb: 15750,
    }),
  };
}

function exchangeCreateOrderTool(): AnyRagTool {
	return {
		name: "create_exchange_order",
		description: "Create exchange order",
		parameters: {} as AnyRagTool["parameters"],
		execute: async () => ({
			ok: false,
			needsVerification: true,
			status: "missing",
			instructions:
				"Для обмена нужно пройти верификацию: пришлите документ, удостоверяющий личность, и короткое видео/кружок с ФИО и фразой о направлении обмена.",
		}),
	};
}

describe("LlmReplyStrategy", () => {
  it("отправляет system + history + текущее в ChatClient, возвращает text envelope", async () => {
    const chat = new CapturingChat("Привет! Чем помочь?");
    const repo = fakeMessagesRepo([
      row(1, "user", "Здравствуйте"),
      row(2, "assistant", "Добрый день!"),
      row(3, "user", "Расскажите про условия"),
    ]);
		const strategy = new LlmReplyStrategy(
			{ template: TEMPLATE, resolveChat: () => chat },
			() => repo,
		);

    const envelopes = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 7,
      inbound: { externalUserId: "u1" },
      userMessageText: "Расскажите про условия",
    });

    const normalized = normalizeReplyStrategyResult(envelopes);
    expect(normalized).not.toBeNull();
		expect(normalized?.envelopes[0]?.parts).toEqual([
			{ kind: "text", text: "Привет! Чем помочь?" },
		]);
    expect(normalized?.envelopes[0]?.externalUserId).toBe("u1");

    // System prompt состоит из base + template fragment.
    const sent = chat.lastCall!.messages;
    expect(sent[0]?.role).toBe("system");
    expect(sent[0]?.content).toContain("Ты — операционный бот");
    expect(sent[0]?.content).toContain("Ты — тестовый бот вертикали.");
    // История правильно конвертится: user/assistant роли.
    expect(sent.slice(1)).toEqual([
      { role: "user", content: "Здравствуйте" },
      { role: "assistant", content: "Добрый день!" },
      { role: "user", content: "Расскажите про условия" },
    ]);
  });

  it("injects rolling conversation summary and keeps only recent raw history", async () => {
    const chat = new SequencedChat(["обсудили старые условия", "Продолжим."]);
    const repo = fakeMessagesRepo([
      row(1, "user", "старый вопрос про условия"),
      row(2, "assistant", "старый ответ"),
      row(3, "user", "ещё старый факт"),
      row(4, "assistant", "сырой контекст"),
      row(5, "user", "текущий вопрос"),
    ]);
    let savedJson = "";
    const strategy = new LlmReplyStrategy(
      {
        template: TEMPLATE,
        resolveChat: () => chat,
        historyLimit: 2,
        compactAfterMessages: 3,
      },
      () => repo,
      () =>
        ({
          findById: async () => ({ summaryJson: null }),
          setSummaryJson: async (_id: number, json: string) => {
            savedJson = json;
          },
        }) as never,
    );

    const envelopes = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 7,
      inbound: { externalUserId: "u1" },
      userMessageText: "текущий вопрос",
      userMessageId: 5,
    });

    expect(firstReplyText(envelopes)).toBe("Продолжим.");
    expect(chat.calls).toHaveLength(2);
    const finalMessages = chat.calls[1] ?? [];
    const system = finalMessages[0]?.content ?? "";
    expect(system).toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
    expect(system).toContain("обсудили старые условия");
    expect(finalMessages.slice(1)).toEqual([
      { role: "assistant", content: "сырой контекст" },
      { role: "user", content: "текущий вопрос" },
    ]);
    expect(JSON.parse(savedJson)).toMatchObject({
      summary: "обсудили старые условия",
      throughMessageId: 3,
    });
  });

  it("конвертит role='human' (operator) в 'assistant' для LLM", async () => {
    const chat = new CapturingChat("ok");
    const repo = fakeMessagesRepo([
      row(1, "user", "?"),
      row(2, "human", "Отвечу через 5 минут"),
    ]);
		const strategy = new LlmReplyStrategy(
			{ template: TEMPLATE, resolveChat: () => chat },
			() => repo,
		);
    await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "?",
    });
    const sent = chat.lastCall!.messages;
		expect(sent.find((m) => m.content === "Отвечу через 5 минут")?.role).toBe(
			"assistant",
		);
  });

  it("injects brokered order context into the system prompt", async () => {
    const chat = new CapturingChat("Контекст учту.");
    const repo = fakeMessagesRepo([]);
    const strategy = new LlmReplyStrategy(
      {
        template: TEMPLATE,
        resolveChat: () => chat,
        resolveServiceOrderContext: () =>
          "BROKERED ORDER CONTEXT\n- order #12 service=massage status=offer_ready amount=1,200 THB",
      },
      () => repo,
    );

    await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 7,
      inbound: { externalUserId: "u1" },
      userMessageText: "что по заявке?",
    });

    const system = chat.lastCall?.messages[0]?.content ?? "";
    expect(system).toContain("BROKERED ORDER CONTEXT");
    expect(system).toContain("order #12");
    expect(system).toContain("status=offer_ready");
  });

  it("uses resolved per-tenant template for the system prompt", async () => {
    const chat = new CapturingChat("tenant reply");
    const repo = fakeMessagesRepo([]);
    const tenantTemplate: VerticalTemplate = {
      ...TEMPLATE,
      slug: "tenant_v1",
      systemPromptFragment: "Ты — tenant-specific бот.",
    };
    const strategy = new LlmReplyStrategy(
      {
        template: TEMPLATE,
        resolveTemplate: (tenantId) => (tenantId === 2 ? tenantTemplate : null),
        resolveChat: () => chat,
      },
      () => repo,
    );

    await strategy.generate({
      tenant: { tenantId: 2 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 7,
      inbound: { externalUserId: "u1" },
      userMessageText: "привет",
    });

    const system = chat.lastCall?.messages[0]?.content ?? "";
    expect(system).toContain("Ты — tenant-specific бот.");
    expect(system).not.toContain("Ты — тестовый бот вертикали.");
  });

  it("пропускает пустой userMessageText (null = бот молчит)", async () => {
    const chat = new CapturingChat("never called");
    const repo = fakeMessagesRepo([]);
		const strategy = new LlmReplyStrategy(
			{ template: TEMPLATE, resolveChat: () => chat },
			() => repo,
		);
    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "",
    });
    expect(result).toBeNull();
    expect(chat.lastCall).toBeNull();
  });

  it("пропускает пустой ответ LLM (null вместо envelope с whitespace)", async () => {
    const chat = new CapturingChat("   ");
    const repo = fakeMessagesRepo([row(1, "user", "?")]);
		const strategy = new LlmReplyStrategy(
			{ template: TEMPLATE, resolveChat: () => chat },
			() => repo,
		);
    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "?",
    });
    expect(result).toBeNull();
  });

  it("exchange: неподкреплённый курс заменяет safe fallback", async () => {
    const chat = new CapturingChat("Курс 31.5, получите 10553 THB.");
    const repo = fakeMessagesRepo([row(1, "user", "сколько за 335 usdt?")]);
    const strategy = new LlmReplyStrategy(
      { template: EXCHANGE_TEMPLATE, resolveChat: () => chat },
      () => repo,
    );
    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "сколько за 335 usdt?",
    });
    expect(result).not.toBeNull();
		expect(firstReplyText(result)).toBe(
			EXCHANGE_SAFE_FALLBACK,
		);
	});

	it("exchange: records response guard finding without tool calls", async () => {
		const chat = new CapturingChat("Курс 31.5, получите 10553 THB.");
		const repo = fakeMessagesRepo([row(1, "user", "сколько за 335 usdt?")]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "сколько за 335 usdt?",
		});

		expect(result).not.toBeNull();
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.guardFindings?.[0]).toMatchObject({
			action: "rewrite",
			reasons: ["unbacked_quote"],
			originalText: "Курс 31.5, получите 10553 THB.",
			finalText: EXCHANGE_SAFE_FALLBACK,
		});
	});

	it("exchange: resolveExchangePolicyState упал → guard работает на null-state", async () => {
		const chat = new CapturingChat("Курс 31.5, получите 10553 THB.");
		const repo = fakeMessagesRepo([row(1, "user", "сколько за 335 usdt?")]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangePolicyState: () =>
					Promise.reject(new Error("policy state db down")),
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "сколько за 335 usdt?",
		});

		// Ошибка резолва не роняет ответ; guard на null-state всё равно
		// отбивает неподкреплённый курс.
		expect(result).not.toBeNull();
		expect(firstReplyText(result)).toBe(EXCHANGE_SAFE_FALLBACK);
	});

	it("exchange: resolveExchangeResponseGuardEnabled упал → guard включён по умолчанию", async () => {
		const chat = new CapturingChat("Курс 31.5, получите 10553 THB.");
		const repo = fakeMessagesRepo([row(1, "user", "сколько за 335 usdt?")]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangeResponseGuardEnabled: () =>
					Promise.reject(new Error("flag db down")),
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "сколько за 335 usdt?",
		});

		expect(result).not.toBeNull();
		expect(firstReplyText(result)).toBe(EXCHANGE_SAFE_FALLBACK);
	});

	it("exchange: response guard can be disabled by tenant flag", async () => {
		const unsafeText = "Курс 31.5, получите 10553 THB.";
		const chat = new CapturingChat(unsafeText);
		const repo = fakeMessagesRepo([row(1, "user", "сколько за 335 usdt?")]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangeResponseGuardEnabled: () => false,
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "сколько за 335 usdt?",
		});

		expect(result).not.toBeNull();
		expect(firstReplyText(result)).toBe(unsafeText);
		expect(recorded).toHaveLength(0);
  });

	  it("exchange: явный запрос курса принудительно считает через compute_exchange_quote", async () => {
    const chat = new CapturingChat("Сейчас уточню у оператора.");
		const repo = fakeMessagesRepo([
			row(1, "user", "500 USDT TRC20 на баты, какой курс?"),
		]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
    const strategy = new LlmReplyStrategy(
      {
        template: EXCHANGE_TEMPLATE,
        resolveChat: () => chat,
        resolveTools: () => [exchangeQuoteTool()],
        recordToolCalls: async (input) => {
          recorded.push(input);
        },
      },
      () => repo,
    );

    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "500 USDT TRC20 на баты, какой курс?",
    });

		    expect(result).not.toBeNull();
		    const text = firstReplyText(result);
		    expect(text).toContain("получите 15750 THB");
	    expect(chat.lastCall).toBeNull();
    expect(recorded[0]?.toolCalls[0]).toMatchObject({
      name: "compute_exchange_quote",
      args: { asset: "USDT", amount: 500, network: "TRC20" },
      cycle: 0,
    });
	  });

	it("exchange: неподдерживаемая сеть (TON) → явный отказ с TRC20/ERC20/BEP20", async () => {
		const mkStrategy = (msg: string) => {
			const chat = new CapturingChat("Сейчас уточню у оператора.");
			const repo = fakeMessagesRepo([row(1, "user", msg)]);
			const strategy = new LlmReplyStrategy(
				{
					template: EXCHANGE_TEMPLATE,
					resolveChat: () => chat,
					resolveTools: () => [exchangeQuoteTool()],
					resolveExchangePolicyState: () => ({ stageSlug: "quote_calculated" }),
				},
				() => repo,
			);
			return { chat, strategy };
		};
		const base = {
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
		};
		// Латиница «сеть TON» → отказ, LLM не дёргаем.
		const a = mkStrategy("сеть TON");
		const t1 = firstReplyText(
			await a.strategy.generate({ ...base, userMessageText: "сеть TON" }),
		);
		expect(t1).toContain("TON");
		expect(t1).toContain("не поддерживаем");
		expect(t1).toContain("TRC20");
		expect(a.chat.lastCall).toBeNull();
		// Кириллица одним словом «тон».
		const b = mkStrategy("тон");
		expect(
			firstReplyText(
				await b.strategy.generate({ ...base, userMessageText: "тон" }),
			),
		).toContain("не поддерживаем");
		// Поддерживаемая сеть → НЕ отказываем, считаем котировку.
		const c = mkStrategy("500 USDT TRC20 на баты, какой курс?");
		const t3 = firstReplyText(
			await c.strategy.generate({
				...base,
				userMessageText: "500 USDT TRC20 на баты, какой курс?",
			}),
		);
		expect(t3).not.toContain("не поддерживаем");
		expect(t3).toContain("получите 15750 THB");
	});

	it("exchange: подтверждение на quote_calculated принудительно ведёт в create_exchange_order/KYC", async () => {
		const chat = new CapturingChat("Повторно считаю сумму.");
		const repo = fakeMessagesRepo([
			row(1, "user", "отдаю 10к рублей нужны песо в банкомате"),
			row(2, "assistant", "Получите 8126 PHP."),
		]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveTools: () => [exchangeQuoteTool(), exchangeCreateOrderTool()],
				resolveExchangePolicyState: () => ({ stageSlug: "quote_calculated" }),
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "супер давай",
		});

		expect(result).not.toBeNull();
		expect(firstReplyText(result)).toBe(
			"Для обмена нужно пройти верификацию: пришлите документ, удостоверяющий личность, и короткое видео/кружок с ФИО и фразой о направлении обмена.",
		);
		expect(chat.lastCall).toBeNull();
		expect(recorded[0]?.toolCalls[0]).toMatchObject({
			name: "create_exchange_order",
			args: { asset: "RUB", amount: 10000, payoutMethod: "atm" },
			cycle: 0,
		});
	});

	it("exchange: краткое «отл» на quote_calculated принудительно ведёт в create_exchange_order", async () => {
		const chat = new CapturingChat("Повторно считаю сумму.");
		const repo = fakeMessagesRepo([
			row(1, "user", "отдаю 10к рублей нужны песо в банкомате"),
			row(2, "assistant", "Получите 8126 PHP."),
		]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveTools: () => [exchangeQuoteTool(), exchangeCreateOrderTool()],
				resolveExchangePolicyState: () => ({ stageSlug: "quote_calculated" }),
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "отл",
		});

		expect(result).not.toBeNull();
		// модель не вызывается — заявку форсим детерминированно
		expect(chat.lastCall).toBeNull();
		expect(recorded[0]?.toolCalls[0]).toMatchObject({
			name: "create_exchange_order",
			args: { asset: "RUB", amount: 10000, payoutMethod: "atm" },
			cycle: 0,
		});
	});

	it("exchange: подтверждение выдаёт заявку И реквизиты в одном сообщении", async () => {
		const chat = new CapturingChat("Повторно считаю сумму.");
		const ADDRESS = "TMockExchangeWallet111111111111111111";
		const repo = fakeMessagesRepo([
			row(1, "user", "отдаю 10к рублей нужны песо в банкомате"),
			row(2, "assistant", "Получите 8126 PHP."),
		]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const createTool: AnyRagTool = {
			name: "create_exchange_order",
			description: "Create order",
			parameters: {} as AnyRagTool["parameters"],
			execute: async () => ({
				orderId: 77,
				status: "awaiting_payment",
				direction: "RUB->PHP",
				amountToThb: 8126,
				rate: 1.23,
			}),
		};
		const reqTool: AnyRagTool = {
			name: "fetch_exchange_requisites",
			description: "Fetch requisites",
			parameters: {} as AnyRagTool["parameters"],
			execute: async () => ({
				orderId: 77,
				kind: "crypto",
				address: ADDRESS,
				network: "trc20",
				ttlMin: 15,
				instructions: `Адрес для USDT (trc20): ${ADDRESS}\nАдрес актуален 15 минут.`,
			}),
		};
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveTools: () => [createTool, reqTool],
				resolveExchangePolicyState: () => ({
					stageSlug: "quote_calculated",
					verification: {
						verified: true,
						status: "verified",
						needsVerification: false,
					},
				}),
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "отл",
		});

		const text = firstReplyText(result);
		expect(text).toContain("заявку оформил");
		expect(text).toContain(ADDRESS);
		expect(chat.lastCall).toBeNull();
		const names = recorded[0]?.toolCalls.map((t) => t.name) ?? [];
		expect(names).toContain("create_exchange_order");
		expect(names).toContain("fetch_exchange_requisites");
	});

	it("exchange: long repeated confirmation-like text does not hit order regex path", async () => {
		const chat = new CapturingChat("Уточню детали.");
		const repo = fakeMessagesRepo([
			row(1, "user", "отдаю 10к рублей нужны песо в банкомате"),
			row(2, "assistant", "Получите 8126 PHP."),
		]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveTools: () => [exchangeQuoteTool(), exchangeCreateOrderTool()],
				resolveExchangePolicyState: () => ({ stageSlug: "quote_calculated" }),
				recordToolCalls: async (input) => {
					recorded.push(input);
				},
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: Array.from({ length: 200 }, () => "\tда").join(""),
		});

		expect(result).not.toBeNull();
		expect(firstReplyText(result)).toBe("Уточню детали.");
		expect(recorded).toHaveLength(0);
		expect(chat.lastCall).not.toBeNull();
	});

	it("exchange: «на счёт, сбер» после выдачи → сводка+подтверждение (не «уточните сумму»)", async () => {
		const chat = new CapturingChat("уточните сумму");
		const repo = fakeMessagesRepo([
			row(1, "user", "хочу обменять 20000 рублей на песо"),
			row(
				2,
				"assistant",
				"Меняем 20000 RUB. Получите 15750 THB. Как удобнее получить деньги?",
			),
			row(3, "user", "в банкомате"),
			row(
				4,
				"assistant",
				"Как удобнее внести рубли — по QR-коду в банк-приложении или банковским переводом со счёта?",
			),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveTools: () => [exchangeQuoteTool()],
				resolveExchangePolicyState: () => ({ stageSlug: "quote_calculated" }),
			},
			() => repo,
		);
		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "на счёт, сбер",
		});
		const text = firstReplyText(result);
		expect(text).toContain("Оформляю заявку?");
		expect(text).toContain("банковским зачислением");
		expect(chat.lastCall).toBeNull(); // forced — не ушли в LLM «уточните сумму»
	});

	it("exchange: грунтинг собранного состояния попадает в system-prompt", async () => {
		const chat = new CapturingChat("Да, мы работаем официально.");
		const repo = fakeMessagesRepo([
			row(1, "user", "хочу обменять 2000 usdt на песо"),
			row(
				2,
				"assistant",
				"Меняем 2000 USDT. Получите 116710 THB. В какой сети?",
			),
		]);
		const strategy = new LlmReplyStrategy(
			{ template: EXCHANGE_TEMPLATE, resolveChat: () => chat },
			() => repo,
		);
		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "а вы надёжная компания?",
		});
		expect(result).not.toBeNull();
		const system = chat.lastCall?.messages[0]?.content ?? "";
		expect(system).toContain("КОНТЕКСТ ЗАЯВКИ");
		expect(system).toContain("2000 USDT");
	});

  it("exchange: стартовый интент с длинным пробельным разрывом проверяется линейно", async () => {
    const userText = `хочу${" ".repeat(25_000)}поменять 500 USDT`;
    const chat = new CapturingChat("Сейчас уточню у оператора.");
    const repo = fakeMessagesRepo([row(1, "user", userText)]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
    const strategy = new LlmReplyStrategy(
      {
        template: EXCHANGE_TEMPLATE,
        resolveChat: () => chat,
        resolveTools: () => [exchangeQuoteTool()],
        recordToolCalls: async (input) => {
          recorded.push(input);
        },
      },
      () => repo,
    );

    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: userText,
	    });

		    expect(result).not.toBeNull();
		    expect(firstReplyText(result)).toContain("получите 15750 THB");
	    expect(chat.lastCall).toBeNull();
		expect(recorded[0]?.toolCalls[0]?.args).toMatchObject({
			asset: "USDT",
			amount: 500,
		});
  });

  it("exchange: в follow-up выбирает source amount рядом с asset, а не THB total", async () => {
    const chat = new CapturingChat("Сейчас уточню у оператора.");
    const repo = fakeMessagesRepo([
			row(
				1,
				"assistant",
				"Курс: 31.5. За 500 USDT (TRC20) получите 15750 THB.",
			),
      row(2, "user", "15750 бат за 500 USDT? Точно?"),
    ]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
    const strategy = new LlmReplyStrategy(
      {
        template: EXCHANGE_TEMPLATE,
        resolveChat: () => chat,
        resolveTools: () => [exchangeQuoteTool()],
        recordToolCalls: async (input) => {
          recorded.push(input);
        },
      },
      () => repo,
    );

    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "15750 бат за 500 USDT? Точно?",
	    });

		    expect(result).not.toBeNull();
		    expect(firstReplyText(result)).toContain("получите 15750 THB");
			expect(recorded[0]?.toolCalls[0]?.args).toMatchObject({
			asset: "USDT",
			amount: 500,
		});
  });

  it("exchange: KYC follow-up with amount is not forced into another quote", async () => {
		const chat = new CapturingChat(
			"Да, видео нужно для верификации перед реквизитами.",
		);
    const repo = fakeMessagesRepo([
			row(
				1,
				"assistant",
				"Для получения батов сначала нужно пройти верификацию.",
			),
      row(2, "user", "Видео-кружок? Для обмена 500 USDT?"),
    ]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
    const strategy = new LlmReplyStrategy(
      {
        template: EXCHANGE_TEMPLATE,
        resolveChat: () => chat,
        resolveTools: () => [exchangeQuoteTool()],
        recordToolCalls: async (input) => {
          recorded.push(input);
        },
      },
      () => repo,
    );

    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "Видео-кружок? Для обмена 500 USDT?",
    });

    expect(result).not.toBeNull();
    const text = firstReplyText(result);
    expect(text).toContain("Перед реквизитами нужна верификация клиента.");
		expect(text).toContain(
			"Оператор или внешний сервис проведёт проверку личности.",
		);
    expect(chat.lastCall).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  it("exchange: KYC confirmation wording does not trigger quote preflight", async () => {
		const chat = new CapturingChat(
			"Да, видео нужно для проверки документов перед оплатой.",
		);
    const repo = fakeMessagesRepo([
			row(
				1,
				"assistant",
				"Для обмена нужно пройти KYC: пришлите документ и видео.",
			),
      row(2, "user", "Точно видео надо для 500 USDT?"),
    ]);
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
    const strategy = new LlmReplyStrategy(
      {
        template: EXCHANGE_TEMPLATE,
        resolveChat: () => chat,
        resolveTools: () => [exchangeQuoteTool()],
        recordToolCalls: async (input) => {
          recorded.push(input);
        },
      },
      () => repo,
    );

    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "Точно видео надо для 500 USDT?",
    });

    expect(result).not.toBeNull();
    const text = firstReplyText(result);
    expect(text).toContain("Перед реквизитами нужна верификация клиента.");
    expect(text).toContain("Пришлите короткое видео");
    expect(chat.lastCall).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  it("exchange: resolved tenant template activates exchange guard", async () => {
    const chat = new CapturingChat("Курс 31.5, получите 10553 THB.");
    const repo = fakeMessagesRepo([row(1, "user", "сколько за 335 usdt?")]);
    const strategy = new LlmReplyStrategy(
      {
        template: TEMPLATE,
        resolveTemplate: () => EXCHANGE_TEMPLATE,
        resolveChat: () => chat,
      },
      () => repo,
    );
    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "сколько за 335 usdt?",
    });
    expect(result).not.toBeNull();
		expect(firstReplyText(result)).toBe(
			EXCHANGE_SAFE_FALLBACK,
		);
  });

  it("exchange: policy guard blocks KYC verification without persisted backing", async () => {
    const chat = new CapturingChat("KYC подтверждён. Продолжаем оформление.");
    const repo = fakeMessagesRepo([
			row(
				1,
				"assistant",
				"Для обмена нужно пройти KYC: пришлите документ и видео.",
			),
      row(2, "user", "отправил видео"),
    ]);
    let resolverInput: unknown = null;
    const strategy = new LlmReplyStrategy(
      {
        template: EXCHANGE_TEMPLATE,
        resolveChat: () => chat,
        resolveExchangePolicyState: (input) => {
          resolverInput = input;
          return {
            stageSlug: "kyc_collection",
            verification: {
              verified: false,
              status: "pending_review",
              needsVerification: true,
            },
          };
        },
      },
      () => repo,
    );

    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "отправил видео",
    });

    expect(resolverInput).toEqual({
      tenantId: 1,
      conversationId: 100,
      contactId: 1,
	    });
	    expect(result).not.toBeNull();
			expect(firstReplyText(result)).toBe(
				EXCHANGE_KYC_FALLBACK,
			);
			expect(normalizeReplyStrategyResult(result)).toMatchObject({
				autoTakeover: true,
				customerNoticeSent: true,
			});
	  });

	it("exchange: auto handoff can stop AI without customer notice", async () => {
		const chat = new CapturingChat("KYC подтверждён. Продолжаем оформление.");
		const repo = fakeMessagesRepo([
			row(1, "assistant", "Для обмена нужно пройти KYC: пришлите видео."),
			row(2, "user", "отправил видео"),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangeCustomerNoticeEnabled: () => false,
				resolveExchangePolicyState: () => ({
					stageSlug: "kyc_collection",
					verification: {
						verified: false,
						status: "pending_review",
						needsVerification: true,
					},
				}),
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "отправил видео",
		});
		const normalized = normalizeReplyStrategyResult(result);

		expect(normalized?.envelopes).toHaveLength(0);
		expect(normalized?.operatorHandoffs?.[0]).toMatchObject({
			reason: "kyc_review",
			stageSlug: "kyc_collection",
		});
		expect(normalized).toMatchObject({
			autoTakeover: true,
			customerNoticeSent: false,
		});
	});

	it("exchange: safe-fallback «уточню у оператора» эскалирует на оператора", async () => {
		// Вопрос вне сценария (другая сеть) — forced-пути не срабатывают, LLM
		// выдаёт обещание оператора. Без эскалации обещание повисает: оператора
		// не уведомили, лид не помечен. Должен быть auto-handoff + хэндофф.
		const chat = new CapturingChat(EXCHANGE_SAFE_FALLBACK);
		const repo = fakeMessagesRepo([
			row(1, "assistant", "Итак: меняем 20000 RUB (TRC20) → получите 16185 PHP."),
			row(2, "user", "а через TON сеть нельзя?"),
		]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangePolicyState: () => ({
					stageSlug: "quote_calculated",
					order: {
						id: 42,
						status: "awaiting_payment",
						direction: "RUB->PHP",
						requisitesIssued: false,
						paymentProofReceived: false,
						paymentVerified: false,
						payoutReady: false,
						payoutCompleted: false,
						payoutCodeIssued: false,
					},
				}),
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "а через TON сеть нельзя?",
		});

		expect(firstReplyText(result)).toBe(EXCHANGE_SAFE_FALLBACK);
		const normalized = normalizeReplyStrategyResult(result);
		expect(normalized).toMatchObject({
			autoTakeover: true,
			customerNoticeSent: true,
		});
		expect(normalized?.operatorHandoffs?.[0]).toMatchObject({
			reason: "operator_request",
			orderId: 42,
		});
	});

	it("exchange: safe-fallback эскалирует и без notice (молча отдаёт оператору)", async () => {
		const chat = new CapturingChat(EXCHANGE_SAFE_FALLBACK);
		const repo = fakeMessagesRepo([row(1, "user", "а через TON сеть нельзя?")]);
		const strategy = new LlmReplyStrategy(
			{
				template: EXCHANGE_TEMPLATE,
				resolveChat: () => chat,
				resolveExchangeCustomerNoticeEnabled: () => false,
			},
			() => repo,
		);

		const result = await strategy.generate({
			tenant: { tenantId: 1 },
			channel: { channelId: 10 },
			conversationId: 100,
			contactId: 1,
			inbound: { externalUserId: "u" },
			userMessageText: "а через TON сеть нельзя?",
		});

		const normalized = normalizeReplyStrategyResult(result);
		expect(normalized?.envelopes).toHaveLength(0);
		expect(normalized).toMatchObject({
			autoTakeover: true,
			customerNoticeSent: false,
		});
		expect(normalized?.operatorHandoffs?.[0]?.reason).toBe("operator_request");
	});

  it("пишет telemetry hook после generic tool-loop", async () => {
    const chat = new ToolLoopChat();
    const repo = fakeMessagesRepo([row(1, "user", "сколько за 100 usdt?")]);
    const tool = makeBookingLinkTool("https://calendly.example/demo");
		const recorded: Array<
			Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]
		> = [];
    const strategy = new LlmReplyStrategy(
      {
        template: TEMPLATE,
        resolveChat: () => chat,
        resolveTools: () => [tool],
        recordToolCalls: async (input) => {
          recorded.push(input);
        },
      },
      () => repo,
    );

    const result = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "сколько за 100 usdt?",
    });

    expect(result).not.toBeNull();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      tenantId: 1,
      conversationId: 100,
      contactId: 1,
      userMessageText: "сколько за 100 usdt?",
      assistantText: "Вот ссылка для записи: https://calendly.example/demo",
    });
    expect(recorded[0]?.toolCalls[0]).toMatchObject({
      name: "offer_booking_link",
      args: {},
      result: { url: "https://calendly.example/demo" },
      cycle: 0,
    });
  });

  it("резолвит ChatClient per-call с tenantId — позволяет invalidate router", async () => {
    const c1 = new CapturingChat("from-client-1");
    const c2 = new CapturingChat("from-client-2");
    const resolved: ChatClient[] = [c1, c2];
    const resolveChat = (_: number) => resolved.shift() ?? c1;
    const repo = fakeMessagesRepo([row(1, "user", "hi")]);
		const strategy = new LlmReplyStrategy(
			{ template: TEMPLATE, resolveChat },
			() => repo,
		);

    const first = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "hi",
    });
    const second = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "hi",
    });
		expect(
			(first as Array<{ parts: Array<{ kind: string; text: string }> }>)![0]!
				.parts[0]!.text,
		).toBe("from-client-1");
		expect(
			(second as Array<{ parts: Array<{ kind: string; text: string }> }>)![0]!
				.parts[0]!.text,
		).toBe("from-client-2");
  });
});
