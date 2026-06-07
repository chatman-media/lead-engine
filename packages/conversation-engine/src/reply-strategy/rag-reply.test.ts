// Unit tests for RagReplyStrategy.generate — RAG reply orchestration. Все
// коллабораторы (chat / embed / kb / messagesRepo / conversations / suggestions)
// фейковые; answerWithRag прогоняется по-настоящему на фейковом KB/chat (как в
// kb/answer.test). Без БД и сети.

import { describe, expect, it } from "bun:test";
import type { ChatClient } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { RagReplyStrategy, type RagReplyStrategyOpts } from "./rag-reply.ts";
import { EXCHANGE_SAFE_FALLBACK } from "./exchange-reply-guard.ts";

const TENANT = { tenantId: 1 };
const CHANNEL = { channelId: 10 };

// job-intent текст — не триггерит persona-shortcuts в answerWithRag.
const QUESTION = "расскажи про условия обмена usdt на баты";

function chatReturning(reply: string): ChatClient {
  return { complete: async () => reply } as unknown as ChatClient;
}

const embed: RagReplyStrategyOpts["resolveEmbed"] = () =>
  ({ embed: async (xs: string[]) => xs.map(() => [1, 0, 0]), dim: 3 }) as never;

function kbWith(hits: unknown[]): RagReplyStrategyOpts["resolveKb"] {
  return () =>
    ({
      search: async () => hits,
      hybridSearch: async () => hits,
      prioritySearch: async () => hits,
    }) as never;
}

const HIT = {
  chunk_id: 1,
  distance: 0.1,
  text: "USDT меняем по курсу 36.5 бат без комиссии",
  document_id: 1,
  source: "kb",
  title: "Курсы",
};

const EXCHANGE_TEMPLATE = {
  slug: "exchange_v1",
  displayName: "Exchange",
  version: 1,
  funnelStages: [],
  systemPromptFragment: "",
} as unknown as VerticalTemplate;

/** Минимальный messagesRepo с recent/countByConversation/insert. */
function fakeMessagesRepo(opts: { recent?: unknown[]; count?: number } = {}) {
  return () =>
    ({
      recent: async () => opts.recent ?? [],
      countByConversation: async () => opts.count ?? 0,
      insert: async () => ({ id: 1 }),
    }) as never;
}

const baseInput = () => ({
  tenant: TENANT,
  channel: CHANNEL,
  conversationId: 100,
  contactId: 5,
  inbound: { externalUserId: "u1" },
  userMessageText: QUESTION,
});

type Repo = ConstructorParameters<typeof RagReplyStrategy>[1];
function mk(opts: Partial<RagReplyStrategyOpts>, repo: Repo): RagReplyStrategy {
  return new RagReplyStrategy(opts as RagReplyStrategyOpts, repo);
}

describe("RagReplyStrategy.generate", () => {
  it("пустой userMessageText → null", async () => {
    const s = mk(
      { resolveChat: () => chatReturning("x"), resolveEmbed: embed, resolveKb: kbWith([]) },
      fakeMessagesRepo(),
    );
    const r = await s.generate({ ...baseInput(), userMessageText: "" });
    expect(r).toBeNull();
  });

  it("resolveIsSupport=true → null (оператор ведёт вручную)", async () => {
    const s = mk(
      {
        resolveChat: () => chatReturning("x"),
        resolveEmbed: embed,
        resolveKb: kbWith([HIT]),
        resolveIsSupport: async () => true,
      },
      fakeMessagesRepo(),
    );
    expect(await s.generate(baseInput())).toBeNull();
  });

  it("happy: KB-хит → envelope с текстом ответа", async () => {
    const s = mk(
      {
        resolveChat: () => chatReturning("Курс 36.5 бат за USDT, без комиссии"),
        resolveEmbed: embed,
        resolveKb: kbWith([HIT]),
      },
      fakeMessagesRepo(),
    );
    const r = await s.generate(baseInput());
    expect(r).not.toBeNull();
    expect(r).toHaveLength(1);
    expect(r![0]!.channelId).toBe("10");
    expect(r![0]!.externalUserId).toBe("u1");
    const part = r![0]!.parts[0] as { kind: string; text: string };
    expect(part.kind).toBe("text");
    expect(part.text.toLowerCase()).toContain("курс");
  });

  it("exchange: неподкреплённый курс заменяется safe fallback", async () => {
    const s = mk(
      {
        template: EXCHANGE_TEMPLATE,
        resolveChat: () => chatReturning("Курс 31.5, получите 10553 THB."),
        resolveEmbed: embed,
        resolveKb: kbWith([HIT]),
      },
      fakeMessagesRepo(),
    );
    const r = await s.generate(baseInput());
    expect(r).not.toBeNull();
    const part = r![0]!.parts[0] as { text: string };
    expect(part.text).toBe(EXCHANGE_SAFE_FALLBACK);
  });

  it("no-context + softFallback → envelope с fallback-текстом + лог в suggestions", async () => {
    let logged = false;
    const s = mk(
      {
        resolveChat: () => chatReturning("Уточню детали и вернусь!"),
        resolveEmbed: embed,
        resolveKb: kbWith([]), // нет хитов → NO_CONTEXT
        softFallback: true,
        resolveSuggestions: () =>
          ({
            log: async () => {
              logged = true;
            },
          }) as never,
      },
      fakeMessagesRepo(),
    );
    const r = await s.generate(baseInput());
    expect(r).not.toBeNull();
    const part = r![0]!.parts[0] as { text: string };
    expect(part.text.length).toBeGreaterThan(0);
    expect(logged).toBe(true);
  });

  it("no-context без softFallback → null", async () => {
    const s = mk(
      {
        resolveChat: () => chatReturning("ответ"),
        resolveEmbed: embed,
        resolveKb: kbWith([]),
        softFallback: false,
      },
      fakeMessagesRepo(),
    );
    expect(await s.generate(baseInput())).toBeNull();
  });

  it("compaction: при превышении порога грузит/пересчитывает summary", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `msg ${i}`,
    }));
    let savedSummary: string | null = null;
    const s = mk(
      {
        resolveChat: () => chatReturning("краткое резюме диалога"),
        resolveEmbed: embed,
        resolveKb: kbWith([HIT]),
        compactAfterMessages: 20,
        resolveConversations: () =>
          ({
            findById: async () => ({ id: 100, summaryJson: null }),
            setSummaryJson: async (_id: number, json: string) => {
              savedSummary = json;
            },
          }) as never,
      },
      fakeMessagesRepo({ recent: many, count: 21 }),
    );
    const r = await s.generate(baseInput());
    expect(r).not.toBeNull();
    // summary пересчитан и сохранён (fire-and-forget) — даём микротаск завершиться
    await new Promise((res) => setTimeout(res, 0));
    expect(savedSummary).not.toBeNull();
  });
});
