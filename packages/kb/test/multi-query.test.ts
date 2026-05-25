import { describe, expect, it } from "bun:test";
import { expandQueries } from "../src/multi-query.ts";
import type { ChatClient } from "@chatman-media/llm-router";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeChatClient(response: string): ChatClient {
  return {
    complete: async () => response,
  } as unknown as ChatClient;
}

function makeFailingClient(): ChatClient {
  return {
    complete: async () => { throw new Error("LLM down"); },
  } as unknown as ChatClient;
}

// ── expandQueries ─────────────────────────────────────────────────────────────

describe("expandQueries", () => {
  it("original question is always first", async () => {
    const chat = makeChatClient("цена апартаментов в Marina Gate\nстоимость юнитов Дубай");
    const result = await expandQueries({ question: "сколько стоит квартира", chat });
    expect(result[0]).toBe("сколько стоит квартира");
  });

  it("returns variants from LLM response", async () => {
    const chat = makeChatClient("цена апартаментов в Marina Gate\nстоимость юнитов Дубай");
    const result = await expandQueries({ question: "сколько стоит квартира", chat });
    expect(result.length).toBe(3); // original + 2 variants
    expect(result[1]).toBe("цена апартаментов в Marina Gate");
    expect(result[2]).toBe("стоимость юнитов Дубай");
  });

  it("respects count option", async () => {
    const chat = makeChatClient("вариант 1\nвариант 2\nвариант 3\nвариант 4");
    const result = await expandQueries({ question: "вопрос", chat, count: 1 });
    expect(result.length).toBe(2); // original + 1 variant
  });

  it("falls back to [original] on LLM failure", async () => {
    const result = await expandQueries({ question: "запрос", chat: makeFailingClient() });
    expect(result).toEqual(["запрос"]);
  });

  it("strips list markers from LLM output", async () => {
    const chat = makeChatClient("1. первый вариант\n- второй вариант\n• третий вариант");
    const result = await expandQueries({ question: "оригинал", chat });
    expect(result[1]).toBe("первый вариант");
    expect(result[2]).toBe("второй вариант");
  });

  it("returns [original] for empty question", async () => {
    const chat = makeChatClient("что-то");
    const result = await expandQueries({ question: "  ", chat });
    expect(result).toEqual([""]);
  });

  it("filters out very short lines from LLM output", async () => {
    // Lines ≤ 3 chars should be skipped
    const chat = makeChatClient("ок\nхороший длинный вариант запроса");
    const result = await expandQueries({ question: "вопрос", chat });
    expect(result.length).toBe(2); // original + 1 (short one skipped)
    expect(result[1]).toBe("хороший длинный вариант запроса");
  });
});
