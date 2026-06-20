import { describe, expect, it } from "bun:test";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { extractUserFacts, parseFactsFromLlmOutput } from "./extract-user-facts.ts";

const chat = (text: string): ChatClient =>
  ({ complete: async () => text }) as unknown as ChatClient;
const chatThrows = (): ChatClient =>
  ({
    complete: async () => {
      throw new Error("x");
    },
  }) as unknown as ChatClient;

describe("parseFactsFromLlmOutput", () => {
  it("нет {} → {}", () => {
    expect(parseFactsFromLlmOutput("no json")).toEqual({});
  });
  it("битый JSON (нет закрывающей скобки) → {}", () => {
    expect(parseFactsFromLlmOutput("{broken")).toEqual({});
  });
  it("есть {} но невалидный JSON → {}", () => {
    expect(parseFactsFromLlmOutput("{broken json}")).toEqual({});
  });
  it("массив → {}", () => {
    expect(parseFactsFromLlmOutput("[1,2]")).toEqual({});
  });
  it("валидный объект + coercion числовых значений", () => {
    expect(parseFactsFromLlmOutput('{"name":"Аня","age":23}')).toEqual({ name: "Аня", age: "23" });
  });
  it("пустые / слишком длинные значения и длинные ключи отбрасываются", () => {
    const longVal = "x".repeat(300);
    const longKey = "k".repeat(50);
    const out = parseFactsFromLlmOutput(
      `{"city":"  ","name":"Аня","big":"${longVal}","${longKey}":"v"}`,
    );
    expect(out).toEqual({ name: "Аня" });
  });
  it("code-fence/think снимаются", () => {
    expect(parseFactsFromLlmOutput('```json\n{"name":"Ира"}\n```')).toEqual({ name: "Ира" });
  });
});

describe("extractUserFacts", () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "я Аня, мне 23" }];
  it("нет user-сообщений → {} без LLM", async () => {
    expect(
      await extractUserFacts({
        messages: [{ role: "assistant", content: "hi" }],
        chat: chatThrows(),
      }),
    ).toEqual({});
  });
  it("парсит факты из LLM", async () => {
    expect(
      await extractUserFacts({ messages: msgs, chat: chat('{"name":"Аня","age":"23"}') }),
    ).toEqual({ name: "Аня", age: "23" });
  });
  it("LLM упал → {}", async () => {
    expect(await extractUserFacts({ messages: msgs, chat: chatThrows() })).toEqual({});
  });
});
