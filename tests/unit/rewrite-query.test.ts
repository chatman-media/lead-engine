import { describe, expect, test } from "bun:test";

import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import {
  questionNeedsRewrite,
  rewriteQuery,
  sanitizeRewritten,
} from "@/rag/rewrite-query.ts";

function fakeChat(reply: string): ChatClient & { calls: number; lastMessages: ChatMessage[] | null } {
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

describe("questionNeedsRewrite", () => {
  test("returns false on empty/no history (nothing to disambiguate)", () => {
    expect(questionNeedsRewrite("где это?", [])).toBe(false);
    expect(questionNeedsRewrite("а там?", undefined)).toBe(false);
  });

  test("returns true on short follow-ups when history exists", () => {
    const history: ChatMessage[] = [{ role: "assistant", content: "в дубае платят 1500" }];
    expect(questionNeedsRewrite("а в стамбуле?", history)).toBe(true);
    expect(questionNeedsRewrite("а виза?", history)).toBe(true);
  });

  test("returns true when message contains deictic markers", () => {
    const history: ChatMessage[] = [{ role: "assistant", content: "контракт 30 дней" }];
    expect(questionNeedsRewrite("это включает жилье или нет?", history)).toBe(true);
    expect(questionNeedsRewrite("там можно с собой питомца взять?", history)).toBe(true);
  });

  test("returns true when message starts with follow-up conjunction", () => {
    const history: ChatMessage[] = [{ role: "assistant", content: "..." }];
    expect(questionNeedsRewrite("и сколько по времени контракт?", history)).toBe(true);
    expect(questionNeedsRewrite("а как с визой?", history)).toBe(true);
  });

  test("returns false on self-contained long question", () => {
    const history: ChatMessage[] = [{ role: "assistant", content: "..." }];
    expect(
      questionNeedsRewrite(
        "сколько платят моделям по контракту в Дубае на 30 дней?",
        history,
      ),
    ).toBe(false);
  });
});

describe("sanitizeRewritten", () => {
  test("strips think tags", () => {
    const raw = "<think>reasoning</think>сколько платят в дубае";
    expect(sanitizeRewritten(raw, "fallback", 200)).toBe("сколько платят в дубае");
  });

  test("strips ответ:/answer: prefix", () => {
    expect(sanitizeRewritten("Ответ: сколько платят", "fb", 200)).toBe("сколько платят");
    expect(sanitizeRewritten("answer: how much", "fb", 200)).toBe("how much");
  });

  test("takes first non-empty line", () => {
    expect(sanitizeRewritten("\n\nстрока 1\nстрока 2", "fb", 200)).toBe("строка 1");
  });

  test("falls back when output is empty", () => {
    expect(sanitizeRewritten("", "original q", 200)).toBe("original q");
    expect(sanitizeRewritten("   \n\n  ", "original q", 200)).toBe("original q");
  });

  test("truncates at maxLength", () => {
    expect(sanitizeRewritten("x".repeat(500), "fb", 100).length).toBe(100);
  });
});

describe("rewriteQuery", () => {
  test("returns original when question is self-contained (no LLM call)", async () => {
    const chat = fakeChat("должно быть проигнорировано");
    const result = await rewriteQuery({
      question: "сколько платят моделям по контракту в Дубае?",
      history: [{ role: "assistant", content: "что-то" }],
      chat,
    });
    expect(result).toBe("сколько платят моделям по контракту в Дубае?");
    expect(chat.calls).toBe(0);
  });

  test("returns original when no history (nothing to expand)", async () => {
    const chat = fakeChat("ignored");
    const result = await rewriteQuery({ question: "а там?", chat });
    expect(result).toBe("а там?");
    expect(chat.calls).toBe(0);
  });

  test("rewrites short follow-up questions using history", async () => {
    const chat = fakeChat("какие условия и оплата в Стамбуле");
    const result = await rewriteQuery({
      question: "а в стамбуле?",
      history: [
        { role: "user", content: "сколько платят в дубае?" },
        { role: "assistant", content: "1500 в день, контракт 30 дней" },
      ],
      chat,
    });
    expect(result).toBe("какие условия и оплата в Стамбуле");
    expect(chat.calls).toBe(1);
  });

  test("falls back to original on LLM error", async () => {
    const failing: ChatClient = {
      async complete() {
        throw new Error("network down");
      },
    };
    const result = await rewriteQuery({
      question: "а там?",
      history: [{ role: "assistant", content: "..." }],
      chat: failing,
    });
    expect(result).toBe("а там?");
  });
});
