import { describe, expect, it } from "bun:test";
import type { ChatClient } from "@chatman-media/llm-router";
import { parseReflection, verifyAnswer } from "./reflect.ts";

const chat = (text: string): ChatClient =>
  ({ complete: async () => text }) as unknown as ChatClient;
const chatThrows = (): ChatClient =>
  ({
    complete: async () => {
      throw new Error("x");
    },
  }) as unknown as ChatClient;

describe("parseReflection", () => {
  it("нет {} → grounded:true", () => {
    expect(parseReflection("plain")).toEqual({ grounded: true });
  });
  it("битый JSON (нет }) → true", () => {
    expect(parseReflection("{nope")).toEqual({ grounded: true });
  });
  it("есть {} но невалидный JSON → true", () => {
    expect(parseReflection("{broken json}")).toEqual({ grounded: true });
  });
  it("grounded non-bool → true", () => {
    expect(parseReflection('{"grounded":1}')).toEqual({ grounded: true });
  });
  it("grounded:true → {true}", () => {
    expect(parseReflection('{"grounded":true}')).toEqual({ grounded: true });
  });
  it("grounded:false → {false, reason}", () => {
    expect(parseReflection('{"grounded":false,"reason":"выдумал город"}')).toEqual({
      grounded: false,
      reason: "выдумал город",
    });
  });
  it("grounded:false без reason → unknown", () => {
    expect(parseReflection('{"grounded":false}')).toEqual({ grounded: false, reason: "unknown" });
  });
});

describe("verifyAnswer", () => {
  const base = { question: "q", answer: "Дубай 1500$", context: "Дубай 1500$" };
  it("пустой ответ → grounded:true", async () => {
    expect(await verifyAnswer({ ...base, answer: "  ", chat: chatThrows() })).toEqual({
      grounded: true,
    });
  });
  it("нет контекста → grounded:true", async () => {
    expect(await verifyAnswer({ ...base, context: "", chat: chatThrows() })).toEqual({
      grounded: true,
    });
  });
  it("LLM-вердикт false → {false,reason}", async () => {
    expect(
      await verifyAnswer({ ...base, chat: chat('{"grounded":false,"reason":"r"}') }),
    ).toMatchObject({ grounded: false });
  });
  it("LLM упал → grounded:true (fail-open)", async () => {
    expect(await verifyAnswer({ ...base, chat: chatThrows() })).toEqual({ grounded: true });
  });
});
