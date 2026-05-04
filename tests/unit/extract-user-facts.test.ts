import { describe, expect, test } from "bun:test";

import {
  extractUserFacts,
  parseFactsFromLlmOutput,
} from "@/rag/extract-user-facts.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";

function fakeChat(reply: string): ChatClient & { lastMessages: ChatMessage[] | null } {
  const wrapper = {
    lastMessages: null as ChatMessage[] | null,
    async complete(messages: ChatMessage[]) {
      wrapper.lastMessages = messages;
      return reply;
    },
  };
  return wrapper as ChatClient & { lastMessages: ChatMessage[] | null };
}

describe("parseFactsFromLlmOutput", () => {
  test("parses bare JSON object", () => {
    expect(parseFactsFromLlmOutput(`{"city":"Москва","age":"25"}`)).toEqual({
      city: "Москва",
      age: "25",
    });
  });

  test("strips markdown code fences", () => {
    expect(
      parseFactsFromLlmOutput("```json\n{\"city\":\"Москва\"}\n```"),
    ).toEqual({ city: "Москва" });
  });

  test("strips think tags before parsing", () => {
    const raw = `<think>let me extract...</think>{"name":"Аня"}`;
    expect(parseFactsFromLlmOutput(raw)).toEqual({ name: "Аня" });
  });

  test("ignores prefix text before JSON", () => {
    expect(parseFactsFromLlmOutput(`Ответ: {"city":"Сочи"}`)).toEqual({
      city: "Сочи",
    });
  });

  test("returns empty object on garbage", () => {
    expect(parseFactsFromLlmOutput("not json at all")).toEqual({});
    expect(parseFactsFromLlmOutput("")).toEqual({});
    expect(parseFactsFromLlmOutput("{ broken")).toEqual({});
  });

  test("returns empty object on JSON array (must be object)", () => {
    expect(parseFactsFromLlmOutput(`["a","b"]`)).toEqual({});
  });

  test("coerces numeric values to strings", () => {
    expect(parseFactsFromLlmOutput(`{"age":25}`)).toEqual({ age: "25" });
  });

  test("drops empty string values", () => {
    expect(parseFactsFromLlmOutput(`{"city":"","name":"Аня"}`)).toEqual({
      name: "Аня",
    });
  });

  test("caps oversized values", () => {
    const huge = "x".repeat(500);
    const result = parseFactsFromLlmOutput(`{"bio":"${huge}"}`);
    // value too long → dropped
    expect(result.bio).toBeUndefined();
  });

  test("caps total number of keys", () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 50; i++) obj[`k${i}`] = `v${i}`;
    const json = JSON.stringify(obj);
    const result = parseFactsFromLlmOutput(json);
    expect(Object.keys(result).length).toBeLessThanOrEqual(20);
  });
});

describe("extractUserFacts", () => {
  test("returns empty object when no user messages present", async () => {
    const chat = fakeChat(`{"name":"Аня"}`);
    const result = await extractUserFacts({
      messages: [{ role: "assistant", content: "привет!" }],
      chat,
    });
    expect(result).toEqual({});
    expect(chat.lastMessages).toBeNull(); // no LLM call at all
  });

  test("calls LLM and parses facts when user messages present", async () => {
    const chat = fakeChat(`{"name":"Аня","city":"Москва"}`);
    const result = await extractUserFacts({
      messages: [
        { role: "user", content: "привет, я Аня из Москвы" },
        { role: "assistant", content: "приятно познакомиться" },
      ],
      chat,
    });
    expect(result).toEqual({ name: "Аня", city: "Москва" });
    expect(chat.lastMessages).not.toBeNull();
  });

  test("includes existing facts in prompt so LLM skips known data", async () => {
    const chat = fakeChat(`{}`);
    await extractUserFacts({
      messages: [{ role: "user", content: "я из Москвы" }],
      chat,
      existingFacts: { city: "Москва", age: "25" },
    });
    const userPrompt = chat.lastMessages?.[1]?.content ?? "";
    expect(userPrompt).toContain("Москва");
    expect(userPrompt).toContain("25");
  });

  test("returns empty object when LLM throws", async () => {
    const failing: ChatClient = {
      async complete() {
        throw new Error("boom");
      },
    };
    const result = await extractUserFacts({
      messages: [{ role: "user", content: "я из Москвы" }],
      chat: failing,
    });
    expect(result).toEqual({});
  });
});
