import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../src/chat.ts";
import { questionNeedsRewrite, sanitizeRewritten } from "../src/rewrite-query.ts";

const history: ChatMessage[] = [
  { role: "user", content: "сколько платят в дубае?" },
  { role: "assistant", content: "в дубае платят 1500 в день" },
];

describe("questionNeedsRewrite", () => {
  test("returns false for an empty question", () => {
    expect(questionNeedsRewrite("", history)).toBe(false);
  });

  test("returns false when there is no history to disambiguate against", () => {
    expect(questionNeedsRewrite("а там?", [])).toBe(false);
    expect(questionNeedsRewrite("а там?")).toBe(false);
  });

  test("returns true for short follow-up questions", () => {
    expect(questionNeedsRewrite("а в стамбуле?", history)).toBe(true);
  });

  test("returns true when a deictic marker points back to prior turns", () => {
    expect(questionNeedsRewrite("расскажи подробнее про это пожалуйста сейчас", history)).toBe(
      true,
    );
  });

  test("returns true when the question starts with a follow-up conjunction", () => {
    expect(questionNeedsRewrite("и какие ещё города доступны для работы", history)).toBe(true);
  });

  test("returns false for a long self-contained question", () => {
    expect(questionNeedsRewrite("какие условия оплаты для моделей в городе Стамбул", history)).toBe(
      false,
    );
  });
});

describe("sanitizeRewritten", () => {
  test("strips think tags", () => {
    expect(sanitizeRewritten("<think>reasoning</think>условия в дубае", "fallback", 200)).toBe(
      "условия в дубае",
    );
  });

  test("strips a code-fenced block, keeping text outside it", () => {
    expect(sanitizeRewritten("```json```\nусловия в дубае", "fallback", 200)).toBe(
      "условия в дубае",
    );
  });

  test("falls back when the whole output is a code-fenced block", () => {
    expect(sanitizeRewritten("```\nусловия в дубае\n```", "fallback", 200)).toBe("fallback");
  });

  test("strips a leading answer prefix", () => {
    expect(sanitizeRewritten("ответ: условия в дубае", "fallback", 200)).toBe("условия в дубае");
  });

  test("takes the first non-empty line", () => {
    expect(sanitizeRewritten("\n  условия в дубае  \nlishnee", "fallback", 200)).toBe(
      "условия в дубае",
    );
  });

  test("truncates to maxLength", () => {
    expect(sanitizeRewritten("abcdefghij", "fallback", 4)).toBe("abcd");
  });

  test("falls back to the original when output is empty", () => {
    expect(sanitizeRewritten("   \n  ", "original question", 200)).toBe("original question");
  });
});
