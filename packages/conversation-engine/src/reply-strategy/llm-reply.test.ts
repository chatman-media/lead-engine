import { makeBookingLinkTool } from "@chatman-media/kb";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { describe, expect, it } from "bun:test";
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
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
