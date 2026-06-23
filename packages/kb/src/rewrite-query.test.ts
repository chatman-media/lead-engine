import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { describe, expect, it } from "bun:test";
import { questionNeedsRewrite, rewriteQuery, sanitizeRewritten } from "./rewrite-query.ts";

const chat = (text: string): ChatClient =>
  ({ complete: async () => text }) as unknown as ChatClient;
const chatThrows = (): ChatClient =>
  ({
    complete: async () => {
      throw new Error("x");
    },
  }) as unknown as ChatClient;
const hist: ChatMessage[] = [{ role: "assistant", content: "в Дубае платят 1500" }];

describe("questionNeedsRewrite", () => {
  it("пустой → false", () => {
    expect(questionNeedsRewrite("   ", hist)).toBe(false);
  });
  it("нет истории → false", () => {
    expect(questionNeedsRewrite("а там как?", [])).toBe(false);
  });
  it("короткий (<=4 слова) с историей → true", () => {
    expect(questionNeedsRewrite("а виза как?", hist)).toBe(true);
  });
  it("дейктик-маркер → true", () => {
    expect(questionNeedsRewrite("сколько стоит это оформление документов в итоге", hist)).toBe(
      true,
    );
  });
  it("follow-up союз в начале → true", () => {
    expect(questionNeedsRewrite("или есть другие варианты работы там сейчас", hist)).toBe(true);
  });
  it("длинный самостоятельный → false", () => {
    expect(
      questionNeedsRewrite("сколько платят моделям в Дубае за месяц работы по контракту", hist),
    ).toBe(false);
  });
});

describe("sanitizeRewritten", () => {
  it("снимает think/fence/«ответ:» и берёт первую строку", () => {
    expect(
      sanitizeRewritten("<think>..</think>ответ: какие условия в Дубае\nещё текст", "fb", 200),
    ).toBe("какие условия в Дубае");
  });
  it("пусто/мусор → fallback", () => {
    expect(sanitizeRewritten("   \n  ", "ОРИГИНАЛ", 200)).toBe("ОРИГИНАЛ");
  });
  it("обрезка по maxLength", () => {
    expect(sanitizeRewritten("абвгде", "fb", 3)).toBe("абв");
  });
});

describe("rewriteQuery", () => {
  it("пустой вопрос → как есть", async () => {
    expect(await rewriteQuery({ question: "  ", chat: chatThrows() })).toBe("");
  });
  it("не нужен рерайт (нет истории) → оригинал без вызова LLM", async () => {
    expect(await rewriteQuery({ question: "а там?", chat: chatThrows() })).toBe("а там?");
  });
  it("нужен рерайт → sanitized из LLM", async () => {
    expect(
      await rewriteQuery({
        question: "а виза?",
        history: hist,
        chat: chat("как оформляется виза"),
      }),
    ).toBe("как оформляется виза");
  });
  it("LLM упал → оригинал", async () => {
    expect(await rewriteQuery({ question: "а виза?", history: hist, chat: chatThrows() })).toBe(
      "а виза?",
    );
  });
});
