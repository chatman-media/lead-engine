import { describe, expect, test } from "bun:test";

import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import {
  cleanSummary,
  summarizeConversation,
} from "@/rag/summarize-conversation.ts";

function fakeChat(reply: string): ChatClient & {
  calls: number;
  lastMessages: ChatMessage[] | null;
} {
  const wrapper = {
    calls: 0,
    lastMessages: null as ChatMessage[] | null,
    async complete(messages: ChatMessage[]) {
      wrapper.calls++;
      wrapper.lastMessages = messages;
      return reply;
    },
  };
  return wrapper as ChatClient & { calls: number; lastMessages: ChatMessage[] | null };
}

describe("cleanSummary", () => {
  test("strips think tags and trims", () => {
    expect(cleanSummary("<think>...</think>  кандидат спросил про Дубай.  ", 600)).toBe(
      "кандидат спросил про Дубай.",
    );
  });

  test("strips markdown fences", () => {
    expect(cleanSummary("```\nкандидат хотел уехать.\n```", 600)).toBe(
      "кандидат хотел уехать.",
    );
  });

  test("strips Summary:/Ответ:/answer: prefix", () => {
    expect(cleanSummary("Summary: бот объяснил визу.", 600)).toBe("бот объяснил визу.");
    expect(cleanSummary("Ответ: бот рассказал.", 600)).toBe("бот рассказал.");
  });

  test("truncates long output at last sentence boundary inside cap", () => {
    const long =
      "Первое предложение. Второе предложение длинное и важное. Третье ещё длиннее, и оно содержит много слов которые точно за каплю.";
    const result = cleanSummary(long, 60);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith(".")).toBe(true); // ended at sentence boundary
  });

  test("falls back to hard slice when no good sentence boundary exists", () => {
    const long = "одно очень длинное предложение без конца которое тянется и тянется без точки";
    const result = cleanSummary(long, 30);
    expect(result.length).toBeLessThanOrEqual(30);
  });
});

describe("summarizeConversation", () => {
  test("returns previousSummary unchanged when no new messages", async () => {
    const chat = fakeChat("must not be used");
    const result = await summarizeConversation({
      messagesToSummarize: [],
      chat,
      previousSummary: "stored summary",
    });
    expect(result).toBe("stored summary");
    expect(chat.calls).toBe(0);
  });

  test("returns empty string when no messages and no previous summary", async () => {
    const chat = fakeChat("ignored");
    const result = await summarizeConversation({ messagesToSummarize: [], chat });
    expect(result).toBe("");
    expect(chat.calls).toBe(0);
  });

  test("calls LLM with dialogue formatted as 'кандидат:' / 'бот:'", async () => {
    const chat = fakeChat("кандидат интересовался Дубаем, бот ответил по контракту.");
    await summarizeConversation({
      messagesToSummarize: [
        { role: "user", content: "сколько платят в дубае?" },
        { role: "assistant", content: "1500 в день, 30 дней контракт" },
      ],
      chat,
    });
    const userPrompt = chat.lastMessages?.[1]?.content ?? "";
    expect(userPrompt).toContain("кандидат: сколько платят в дубае?");
    expect(userPrompt).toContain("бот: 1500 в день");
  });

  test("includes previous summary in refinement prompt", async () => {
    const chat = fakeChat("обновлённое summary");
    await summarizeConversation({
      messagesToSummarize: [{ role: "user", content: "ещё один вопрос" }],
      chat,
      previousSummary: "ранее обсуждали Дубай и контракт",
    });
    const userPrompt = chat.lastMessages?.[1]?.content ?? "";
    expect(userPrompt).toContain("ПРЕДЫДУЩЕЕ SUMMARY");
    expect(userPrompt).toContain("ранее обсуждали Дубай");
  });

  test("falls back to previousSummary on LLM error", async () => {
    const failing: ChatClient = {
      async complete() {
        throw new Error("network");
      },
    };
    const result = await summarizeConversation({
      messagesToSummarize: [{ role: "user", content: "x" }],
      chat: failing,
      previousSummary: "stable summary",
    });
    expect(result).toBe("stable summary");
  });
});
