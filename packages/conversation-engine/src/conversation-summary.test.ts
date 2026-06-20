import { describe, expect, it } from "bun:test";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import {
  loadRollingConversationContext,
  parseConversationSummaryPayload,
  renderConversationSummaryBlock,
} from "./conversation-summary.ts";
import type { MessageRow, MessagesRepo } from "./dal/messages.ts";

function row(id: number, text: string, role: MessageRow["role"] = "user"): MessageRow {
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
    origLang: null,
    translatedText: null,
    translatedLang: null,
  };
}

function messagesRepo(
  rows: MessageRow[],
): Pick<MessagesRepo, "recent" | "countByConversation" | "forConversationSummary"> {
  return {
    recent: async (_conversationId, limit) => rows.slice(-limit),
    countByConversation: async () => rows.length,
    forConversationSummary: async (_conversationId, opts) =>
      rows
        .filter(
          (item) =>
            item.id < opts.beforeMessageId &&
            (opts.afterMessageId == null || item.id > opts.afterMessageId) &&
            item.deletedAt == null &&
            item.role !== "system",
        )
        .slice(0, opts.limit),
  };
}

function chatReturning(reply: string, captured: ChatMessage[][] = []): ChatClient {
  return {
    complete: async (messages: ChatMessage[]) => {
      captured.push(messages);
      return reply;
    },
  } as unknown as ChatClient;
}

describe("renderConversationSummaryBlock", () => {
  it("пустая/отсутствующая строка → пустой блок", () => {
    expect(renderConversationSummaryBlock(undefined)).toBe("");
    expect(renderConversationSummaryBlock("  ")).toBe("");
  });
  it("непустая строка → блок с заголовком", () => {
    expect(renderConversationSummaryBlock("факты")).toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
    expect(renderConversationSummaryBlock("факты")).toContain("факты");
  });
});

describe("parseConversationSummaryPayload edge cases", () => {
  it("JSON-число (не строка/объект) → legacy payload из исходной строки", () => {
    expect(parseConversationSummaryPayload("42")).toMatchObject({ summary: "42" });
    expect(parseConversationSummaryPayload("true")).toMatchObject({ summary: "true" });
  });
});

describe("conversation rolling summary", () => {
  it("parses structured, JSON-string, and plain legacy summary values", () => {
    expect(
      parseConversationSummaryPayload(
        '{"version":1,"summary":"old facts","throughMessageId":12,"updatedAt":100}',
      ),
    ).toMatchObject({ summary: "old facts", throughMessageId: 12 });
    expect(parseConversationSummaryPayload('"json string"')).toMatchObject({
      summary: "json string",
      throughMessageId: 0,
    });
    expect(parseConversationSummaryPayload("plain string")).toMatchObject({
      summary: "plain string",
      throughMessageId: 0,
    });
  });

  it("summarizes only messages older than the raw recent window", async () => {
    const captured: ChatMessage[][] = [];
    let savedJson = "";
    const ctx = await loadRollingConversationContext({
      conversationId: 100,
      messages: messagesRepo([
        row(1, "old 1"),
        row(2, "old 2", "assistant"),
        row(3, "old 3"),
        row(4, "raw 4"),
        row(5, "raw 5", "assistant"),
        row(6, "current question"),
      ]),
      conversations: {
        findById: async () => ({ summaryJson: null }),
        setSummaryJson: async (_id, json) => {
          savedJson = json;
        },
      },
      chat: chatReturning("summary of old rows", captured),
      currentMessageId: 6,
      options: { recentWindow: 2, summarizeAfterMessages: 3 },
      nowEpoch: 123,
    });

    expect(ctx.history.map((item) => item.id)).toEqual([4, 5]);
    expect(ctx.conversationSummary).toBe("summary of old rows");
    const prompt = captured[0]?.find((m) => m.role === "user")?.content ?? "";
    expect(prompt).toContain("old 1");
    expect(prompt).toContain("old 2");
    expect(prompt).toContain("old 3");
    expect(prompt).not.toContain("raw 4");
    expect(JSON.parse(savedJson)).toMatchObject({
      version: 1,
      summary: "summary of old rows",
      throughMessageId: 3,
      updatedAt: 123,
    });
  });

  it("updates existing summary from messages after throughMessageId only", async () => {
    const captured: ChatMessage[][] = [];
    let savedJson = "";
    const ctx = await loadRollingConversationContext({
      conversationId: 100,
      messages: messagesRepo([
        row(1, "already summarized"),
        row(2, "already summarized"),
        row(3, "already summarized"),
        row(4, "new old fact"),
        row(5, "raw 5"),
        row(6, "raw 6"),
        row(7, "current"),
      ]),
      conversations: {
        findById: async () => ({
          summaryJson: JSON.stringify({
            version: 1,
            summary: "previous summary",
            throughMessageId: 3,
            updatedAt: 100,
          }),
        }),
        setSummaryJson: async (_id, json) => {
          savedJson = json;
        },
      },
      chat: chatReturning("updated summary", captured),
      currentMessageId: 7,
      options: { recentWindow: 2, summarizeAfterMessages: 3 },
      nowEpoch: 200,
    });

    expect(ctx.history.map((item) => item.id)).toEqual([5, 6]);
    expect(ctx.conversationSummary).toBe("updated summary");
    const prompt = captured[0]?.find((m) => m.role === "user")?.content ?? "";
    expect(prompt).toContain("ПРЕДЫДУЩЕЕ SUMMARY");
    expect(prompt).toContain("previous summary");
    expect(prompt).toContain("new old fact");
    expect(prompt).not.toContain("already summarized");
    expect(JSON.parse(savedJson)).toMatchObject({
      summary: "updated summary",
      throughMessageId: 4,
      updatedAt: 200,
    });
  });

  it("ошибка при загрузке snapshot → возврат истории без summary (best-effort)", async () => {
    const warned: unknown[] = [];
    const ctx = await loadRollingConversationContext({
      conversationId: 100,
      messages: messagesRepo([row(1, "a"), row(2, "current")]),
      conversations: {
        findById: async () => {
          throw new Error("db down");
        },
        setSummaryJson: async () => {},
      },
      chat: chatReturning("ignored"),
      currentMessageId: 2,
      options: { recentWindow: 1, summarizeAfterMessages: 1 },
      onWarn: (_msg, err) => warned.push(err),
    });
    expect(ctx.conversationSummary).toBeUndefined();
    expect(warned).toHaveLength(1);
  });

  it("мало сообщений (totalCount < threshold) → ранний выход без summary", async () => {
    const ctx = await loadRollingConversationContext({
      conversationId: 100,
      messages: messagesRepo([row(1, "only message")]),
      conversations: {
        findById: async () => ({ summaryJson: null }),
        setSummaryJson: async () => {},
      },
      chat: chatReturning("ignored"),
      currentMessageId: 1,
      options: { recentWindow: 2, summarizeAfterMessages: 10 },
    });
    expect(ctx.conversationSummary).toBeUndefined();
  });

  it("нет beforeMessageId (recentWindow=0, без currentMessageId) → ранний выход", async () => {
    const ctx = await loadRollingConversationContext({
      conversationId: 100,
      messages: messagesRepo([row(1, "a"), row(2, "b"), row(3, "c")]),
      conversations: {
        findById: async () => ({ summaryJson: null }),
        setSummaryJson: async () => {},
      },
      chat: chatReturning("ignored"),
      options: { recentWindow: 0, summarizeAfterMessages: 2 },
    });
    expect(ctx.history).toEqual([]);
    expect(ctx.conversationSummary).toBeUndefined();
  });

  it("currentMessageText-деdup удаляет последнее совпадение из истории по тексту", async () => {
    const ctx = await loadRollingConversationContext({
      conversationId: 100,
      messages: messagesRepo([
        row(1, "привет"),
        row(2, "как дела", "assistant"),
        row(3, "подробнее"),
      ]),
      conversations: {
        findById: async () => ({ summaryJson: null }),
        setSummaryJson: async () => {},
      },
      chat: chatReturning("ignored"),
      currentMessageText: "подробнее",
      options: { recentWindow: 3, summarizeAfterMessages: 100 },
    });
    expect(ctx.history.map((m) => m.id)).toEqual([1, 2]);
  });

  it("throughMessageId=0 (falsy) → ранний выход без сохранения", async () => {
    let saved = false;
    const ctx = await loadRollingConversationContext({
      conversationId: 100,
      messages: {
        ...messagesRepo([row(1, "old"), row(2, "raw"), row(3, "current")]),
        forConversationSummary: async () => [{ ...row(1, "old"), id: 0 }],
      },
      conversations: {
        findById: async () => ({ summaryJson: null }),
        setSummaryJson: async () => {
          saved = true;
        },
      },
      chat: chatReturning("new summary"),
      currentMessageId: 3,
      options: { recentWindow: 1, summarizeAfterMessages: 2 },
    });
    expect(saved).toBe(false);
    expect(ctx.conversationSummary).toBeUndefined();
  });

  it("LLM вернул пустое summary → ранний выход без сохранения", async () => {
    let saved = false;
    const ctx = await loadRollingConversationContext({
      conversationId: 100,
      messages: {
        ...messagesRepo([row(1, "old"), row(2, "raw"), row(3, "current")]),
        forConversationSummary: async () => [row(1, "old")],
      },
      conversations: {
        findById: async () => ({ summaryJson: null }),
        setSummaryJson: async () => {
          saved = true;
        },
      },
      chat: chatReturning(""),
      currentMessageId: 3,
      options: { recentWindow: 1, summarizeAfterMessages: 2 },
    });
    expect(saved).toBe(false);
    expect(ctx.conversationSummary).toBeUndefined();
  });

  it("ошибка при сохранении summary → продолжает работу, onWarn вызывается", async () => {
    const warned: unknown[] = [];
    const ctx = await loadRollingConversationContext({
      conversationId: 100,
      messages: {
        ...messagesRepo([row(1, "old"), row(2, "raw"), row(3, "current")]),
        forConversationSummary: async () => [row(1, "old")],
      },
      conversations: {
        findById: async () => ({ summaryJson: null }),
        setSummaryJson: async () => {
          throw new Error("db write failed");
        },
      },
      chat: chatReturning("new summary text"),
      currentMessageId: 3,
      options: { recentWindow: 1, summarizeAfterMessages: 2 },
      onWarn: (_msg, err) => warned.push(err),
    });
    expect(ctx.conversationSummary).toBe("new summary text");
    expect(warned).toHaveLength(1);
  });

  it("returns legacy summary when there are no new old messages", async () => {
    const ctx = await loadRollingConversationContext({
      conversationId: 100,
      messages: messagesRepo([row(1, "raw 1"), row(2, "current")]),
      conversations: {
        findById: async () => ({ summaryJson: '"legacy summary"' }),
        setSummaryJson: async () => {
          throw new Error("should not save");
        },
      },
      chat: chatReturning("should not be called"),
      currentMessageId: 2,
      options: { recentWindow: 1, summarizeAfterMessages: 2 },
    });

    expect(ctx.history.map((item) => item.id)).toEqual([1]);
    expect(ctx.conversationSummary).toBe("legacy summary");
  });
});
