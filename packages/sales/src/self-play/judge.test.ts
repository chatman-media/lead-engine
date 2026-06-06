import type { ChatClient } from "@chatman-media/llm-router";
import { describe, expect, it } from "bun:test";
import { judgeMatch, parseVerdict } from "./judge.ts";

const chatReturning = (text: string): ChatClient =>
  ({ complete: async () => text }) as unknown as ChatClient;
const chatThrowing = (): ChatClient =>
  ({
    complete: async () => {
      throw new Error("boom");
    },
  }) as unknown as ChatClient;

const input = (chat: ChatClient) => ({
  styleSlug: "marina",
  personaSlug: "anxious",
  judgingHint: "won = committed",
  transcript: [{ role: "candidate" as const, text: "ok" }],
  chat,
});

describe("parseVerdict", () => {
  it("чистый JSON", () => {
    expect(parseVerdict('{"outcome":"won","reason":"committed"}')).toMatchObject({ outcome: "won", reason: "committed" });
  });
  it("code-fenced JSON", () => {
    expect(parseVerdict('```json\n{"outcome":"lost","reason":"walked"}\n```').outcome).toBe("lost");
  });
  it("regex-fallback при битом JSON", () => {
    expect(parseVerdict('blah "outcome": "draw" something not-json').outcome).toBe("draw");
  });
  it("невалидный outcome без regex → draw + raw", () => {
    const v = parseVerdict("totally unparseable");
    expect(v.outcome).toBe("draw");
    expect(v.raw).toBe("totally unparseable");
  });
  it("reason не строка → (no reason)", () => {
    expect(parseVerdict('{"outcome":"won","reason":42}').reason).toBe("(no reason)");
  });
});

describe("judgeMatch", () => {
  it("парсит вердикт из LLM", async () => {
    const v = await judgeMatch(input(chatReturning('{"outcome":"won","reason":"yes"}')));
    expect(v.outcome).toBe("won");
  });
  it("LLM упал → draw с описанием ошибки", async () => {
    const v = await judgeMatch(input(chatThrowing()));
    expect(v.outcome).toBe("draw");
    expect(v.reason).toContain("judge LLM failed");
  });
});
