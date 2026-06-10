import { type AnyRagTool, makeBookingLinkTool } from "@chatman-media/kb";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { describe, expect, it } from "bun:test";
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
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
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
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
    return { content: "Вот ссылка для записи: https://calendly.example/demo", toolCalls: [] };
  }
}

function fakeMessagesRepo(history: MessageRow[]) {
  return {
    recent: async () => history,
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

describe("LlmReplyStrategy", () => {
  it("отправляет system + history + текущее в ChatClient, возвращает text envelope", async () => {
    const chat = new CapturingChat("Привет! Чем помочь?");
    const repo = fakeMessagesRepo([
      row(1, "user", "Здравствуйте"),
      row(2, "assistant", "Добрый день!"),
      row(3, "user", "Расскажите про условия"),
    ]);
    const strategy = new LlmReplyStrategy({ template: TEMPLATE, resolveChat: () => chat }, () => repo);

    const envelopes = await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 7,
      inbound: { externalUserId: "u1" },
      userMessageText: "Расскажите про условия",
    });

    expect(envelopes).not.toBeNull();
    expect(envelopes![0]?.parts).toEqual([{ kind: "text", text: "Привет! Чем помочь?" }]);
    expect(envelopes![0]?.externalUserId).toBe("u1");

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

  it("конвертит role='human' (operator) в 'assistant' для LLM", async () => {
    const chat = new CapturingChat("ok");
    const repo = fakeMessagesRepo([
      row(1, "user", "?"),
      row(2, "human", "Отвечу через 5 минут"),
    ]);
    const strategy = new LlmReplyStrategy({ template: TEMPLATE, resolveChat: () => chat }, () => repo);
    await strategy.generate({
      tenant: { tenantId: 1 },
      channel: { channelId: 10 },
      conversationId: 100,
      contactId: 1,
      inbound: { externalUserId: "u" },
      userMessageText: "?",
    });
    const sent = chat.lastCall!.messages;
    expect(sent.find((m) => m.content === "Отвечу через 5 минут")?.role).toBe("assistant");
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
    const strategy = new LlmReplyStrategy({ template: TEMPLATE, resolveChat: () => chat }, () => repo);
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
    const strategy = new LlmReplyStrategy({ template: TEMPLATE, resolveChat: () => chat }, () => repo);
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
    expect((result![0]!.parts[0] as { text: string }).text).toBe(EXCHANGE_SAFE_FALLBACK);
  });

  it("exchange: явный запрос курса принудительно считает через compute_exchange_quote", async () => {
    const chat = new CapturingChat("Сейчас уточню у оператора.");
    const repo = fakeMessagesRepo([row(1, "user", "500 USDT TRC20 на баты, какой курс?")]);
    const recorded: Array<Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]> = [];
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
    const text = (result![0]!.parts[0] as { text: string }).text;
    expect(text).toContain("Курс: 31.5.");
    expect(text).toContain("За 500 USDT (TRC20) получите 15750 THB.");
    expect(chat.lastCall).toBeNull();
    expect(recorded[0]?.toolCalls[0]).toMatchObject({
      name: "compute_exchange_quote",
      args: { asset: "USDT", amount: 500, network: "TRC20" },
      cycle: 0,
    });
  });

  it("exchange: стартовый интент с длинным пробельным разрывом проверяется линейно", async () => {
    const userText = `хочу${" ".repeat(25_000)}поменять 500 USDT`;
    const chat = new CapturingChat("Сейчас уточню у оператора.");
    const repo = fakeMessagesRepo([row(1, "user", userText)]);
    const recorded: Array<Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]> = [];
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
    const part = result?.[0]?.parts[0];
    expect(part?.kind).toBe("text");
    expect(part?.kind === "text" ? part.text : "").toContain(
      "За 500 USDT (TRC20) получите 15750 THB.",
    );
    expect(chat.lastCall).toBeNull();
    expect(recorded[0]?.toolCalls[0]?.args).toMatchObject({ asset: "USDT", amount: 500 });
  });

  it("exchange: в follow-up выбирает source amount рядом с asset, а не THB total", async () => {
    const chat = new CapturingChat("Сейчас уточню у оператора.");
    const repo = fakeMessagesRepo([
      row(1, "assistant", "Курс: 31.5. За 500 USDT (TRC20) получите 15750 THB."),
      row(2, "user", "15750 бат за 500 USDT? Точно?"),
    ]);
    const recorded: Array<Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]> = [];
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
    expect((result![0]!.parts[0] as { text: string }).text).toContain(
      "За 500 USDT (TRC20) получите 15750 THB.",
    );
    expect(recorded[0]?.toolCalls[0]?.args).toMatchObject({ asset: "USDT", amount: 500 });
  });

  it("exchange: KYC follow-up with amount is not forced into another quote", async () => {
    const chat = new CapturingChat("Да, видео нужно для верификации перед реквизитами.");
    const repo = fakeMessagesRepo([
      row(1, "assistant", "Для получения батов сначала нужно пройти верификацию."),
      row(2, "user", "Видео-кружок? Для обмена 500 USDT?"),
    ]);
    const recorded: Array<Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]> = [];
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
    const text = (result![0]!.parts[0] as { text: string }).text;
    expect(text).toContain("Перед реквизитами нужна верификация клиента.");
    expect(text).toContain("Оператор или внешний сервис проведёт проверку личности.");
    expect(chat.lastCall).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  it("exchange: KYC confirmation wording does not trigger quote preflight", async () => {
    const chat = new CapturingChat("Да, видео нужно для проверки документов перед оплатой.");
    const repo = fakeMessagesRepo([
      row(1, "assistant", "Для обмена нужно пройти KYC: пришлите документ и видео."),
      row(2, "user", "Точно видео надо для 500 USDT?"),
    ]);
    const recorded: Array<Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]> = [];
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
    const text = (result![0]!.parts[0] as { text: string }).text;
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
    expect((result![0]!.parts[0] as { text: string }).text).toBe(EXCHANGE_SAFE_FALLBACK);
  });

  it("exchange: policy guard blocks KYC verification without persisted backing", async () => {
    const chat = new CapturingChat("KYC подтверждён. Продолжаем оформление.");
    const repo = fakeMessagesRepo([
      row(1, "assistant", "Для обмена нужно пройти KYC: пришлите документ и видео."),
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
    expect((result![0]!.parts[0] as { text: string }).text).toBe(EXCHANGE_KYC_FALLBACK);
  });

  it("пишет telemetry hook после generic tool-loop", async () => {
    const chat = new ToolLoopChat();
    const repo = fakeMessagesRepo([row(1, "user", "сколько за 100 usdt?")]);
    const tool = makeBookingLinkTool("https://calendly.example/demo");
    const recorded: Array<Parameters<NonNullable<LlmReplyStrategyOpts["recordToolCalls"]>>[0]> = [];
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
    const strategy = new LlmReplyStrategy({ template: TEMPLATE, resolveChat }, () => repo);

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
    expect((first as Array<{ parts: Array<{ kind: string; text: string }> }>)![0]!.parts[0]!.text).toBe("from-client-1");
    expect((second as Array<{ parts: Array<{ kind: string; text: string }> }>)![0]!.parts[0]!.text).toBe("from-client-2");
  });
});
