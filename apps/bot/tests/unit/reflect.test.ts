import { describe, expect, test } from "bun:test";

import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import { parseReflection, verifyAnswer } from "@/rag/reflect.ts";

function fakeChat(reply: string): ChatClient & { calls: number } {
  const wrapper = {
    calls: 0,
    async complete(_messages: ChatMessage[]) {
      wrapper.calls++;
      return reply;
    },
  };
  return wrapper as ChatClient & { calls: number };
}

describe("parseReflection", () => {
  test("parses {grounded:true}", () => {
    expect(parseReflection(`{"grounded":true}`)).toEqual({ grounded: true });
  });

  test("parses {grounded:false} with reason", () => {
    expect(parseReflection(`{"grounded":false,"reason":"city not in context"}`)).toEqual({
      grounded: false,
      reason: "city not in context",
    });
  });

  test("strips think tags and markdown", () => {
    const raw = `<think>...</think>\n\`\`\`json\n{"grounded":false,"reason":"x"}\n\`\`\``;
    expect(parseReflection(raw)).toEqual({ grounded: false, reason: "x" });
  });

  test("defaults to grounded:true on parse failure (fail-open)", () => {
    expect(parseReflection("not json")).toEqual({ grounded: true });
    expect(parseReflection("")).toEqual({ grounded: true });
    expect(parseReflection("{")).toEqual({ grounded: true });
  });

  test("defaults to grounded:true when grounded field is missing", () => {
    expect(parseReflection(`{"reason":"x"}`)).toEqual({ grounded: true });
  });

  test("defaults reason to 'unknown' when ungrounded but no reason given", () => {
    expect(parseReflection(`{"grounded":false}`)).toEqual({
      grounded: false,
      reason: "unknown",
    });
  });
});

describe("verifyAnswer", () => {
  test("skips LLM call on empty answer", async () => {
    const chat = fakeChat(`{"grounded":false}`);
    const result = await verifyAnswer({
      question: "?",
      answer: "  ",
      context: "ctx",
      chat,
    });
    expect(result.grounded).toBe(true);
    expect(chat.calls).toBe(0);
  });

  test("skips LLM call on empty context (cannot verify, let through)", async () => {
    const chat = fakeChat(`{"grounded":false}`);
    const result = await verifyAnswer({
      question: "?",
      answer: "real answer",
      context: "",
      chat,
    });
    expect(result.grounded).toBe(true);
    expect(chat.calls).toBe(0);
  });

  test("calls LLM and returns grounded:true when verifier confirms", async () => {
    const chat = fakeChat(`{"grounded":true}`);
    const result = await verifyAnswer({
      question: "сколько платят?",
      answer: "1500 юаней в день",
      context: "1500 юаней в день за смену в шаохинге",
      chat,
    });
    expect(result.grounded).toBe(true);
    expect(chat.calls).toBe(1);
  });

  test("returns grounded:false with reason when verifier flags hallucination", async () => {
    const chat = fakeChat(`{"grounded":false,"reason":"5000 евро not in context"}`);
    const result = await verifyAnswer({
      question: "сколько платят?",
      answer: "5000 евро в день",
      context: "1500 юаней в день",
      chat,
    });
    expect(result).toEqual({
      grounded: false,
      reason: "5000 евро not in context",
    });
  });

  test("fail-open on LLM error (returns grounded:true)", async () => {
    const failing: ChatClient = {
      async complete() {
        throw new Error("verifier down");
      },
    };
    const result = await verifyAnswer({
      question: "?",
      answer: "any",
      context: "ctx",
      chat: failing,
    });
    expect(result.grounded).toBe(true);
  });
});
