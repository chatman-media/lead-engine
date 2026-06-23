import { describe, expect, test } from "bun:test";
import type { ChatClient } from "@chatman-media/llm-router";
import { cleanSummary, summarizeConversation } from "./summarize-conversation.ts";

// ── cleanSummary (pure function) ──────────────────────────────────────────────
describe("cleanSummary", () => {
  test("returns as-is when within maxLength", () => {
    expect(cleanSummary("Hello world.", 100)).toBe("Hello world.");
  });

  test("strips leading 'summary:' prefix (case-insensitive)", () => {
    expect(cleanSummary("Summary: some text.", 200)).toBe("some text.");
  });

  test("strips leading 'ответ:' prefix", () => {
    expect(cleanSummary("Ответ: some text.", 200)).toBe("some text.");
  });

  test("strips ``` fences but keeps content", () => {
    expect(cleanSummary("```\nsome text.\n```", 200)).toContain("some text.");
  });

  test("truncates at last sentence boundary when over maxLength", () => {
    // "First sentence." is at pos 0-14, maxLength=20 → lastPunct=14, 14>20*0.6=12 → trim at 15
    const raw = "First sentence. Second sentence. Third sentence.";
    const result = cleanSummary(raw, 20);
    expect(result.endsWith(".")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  test("hard truncates when no sentence boundary found near cap", () => {
    const raw = "abcdefghijklmnopqrstuvwxyz"; // no punctuation
    const result = cleanSummary(raw, 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });
});

// ── summarizeConversation ─────────────────────────────────────────────────────
describe("summarizeConversation", () => {
  const fakeChat = (response: string): ChatClient =>
    ({ complete: async () => response }) as unknown as ChatClient;

  test("returns previousSummary immediately when messagesToSummarize is empty", async () => {
    const result = await summarizeConversation({
      messagesToSummarize: [],
      chat: fakeChat("should not be called"),
      previousSummary: "existing summary",
    });
    expect(result).toBe("existing summary");
  });

  test("returns empty string when no messages and no previousSummary", async () => {
    const result = await summarizeConversation({
      messagesToSummarize: [],
      chat: fakeChat("nope"),
    });
    expect(result).toBe("");
  });

  test("calls LLM and returns cleaned result", async () => {
    const result = await summarizeConversation({
      messagesToSummarize: [
        { role: "user", content: "кандидат спросил про зарплату" },
        { role: "assistant", content: "бот объяснил условия" },
      ],
      chat: fakeChat("Кандидат уточнил зарплатные ожидания. Бот объяснил условия."),
    });
    expect(result).toContain("Кандидат");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns previousSummary when LLM throws", async () => {
    const errorChat = {
      complete: async () => {
        throw new Error("llm down");
      },
    } as unknown as ChatClient;
    const result = await summarizeConversation({
      messagesToSummarize: [{ role: "user", content: "hello" }],
      chat: errorChat,
      previousSummary: "fallback summary",
    });
    expect(result).toBe("fallback summary");
  });

  test("respects maxLength option", async () => {
    const longText = "A".repeat(200) + ".";
    const result = await summarizeConversation({
      messagesToSummarize: [{ role: "user", content: "x" }],
      chat: fakeChat(longText),
      maxLength: 50,
    });
    expect(result.length).toBeLessThanOrEqual(50);
  });
});
