import type { ChatClient } from "@chatman-media/llm-router";
import { describe, expect, it } from "bun:test";
import { judgePairwise, parsePairwiseVerdict } from "./pairwise.ts";

const chat = (text: string): ChatClient => ({ complete: async () => text }) as unknown as ChatClient;
const chatThrows = (): ChatClient =>
  ({
    complete: async () => {
      throw new Error("down");
    },
  }) as unknown as ChatClient;

const args = (c: ChatClient) => ({
  judgingHint: "better = closes",
  styleASlug: "a",
  styleBSlug: "b",
  transcriptA: [{ role: "candidate" as const, text: "hi" }],
  transcriptB: [{ role: "candidate" as const, text: "hi" }],
  chat: c,
});

describe("parsePairwiseVerdict", () => {
  it("чистый JSON", () => {
    expect(parsePairwiseVerdict('{"winner":"b","reason":"closed"}')).toMatchObject({ winner: "b", reason: "closed" });
  });
  it("code-fenced", () => {
    expect(parsePairwiseVerdict('```json\n{"winner":"a","reason":"x"}\n```').winner).toBe("a");
  });
  it("regex-fallback", () => {
    expect(parsePairwiseVerdict('noise "winner": "draw" tail').winner).toBe("draw");
  });
  it("неразборчиво → draw + raw", () => {
    const v = parsePairwiseVerdict("nothing here");
    expect(v.winner).toBe("draw");
    expect(v.raw).toBe("nothing here");
  });
});

describe("judgePairwise", () => {
  it("парсит winner из LLM", async () => {
    expect((await judgePairwise(args(chat('{"winner":"b","reason":"ok"}')))).winner).toBe("b");
  });
  it("LLM упал → draw", async () => {
    const v = await judgePairwise(args(chatThrows()));
    expect(v.winner).toBe("draw");
    expect(v.reason).toContain("pairwise judge failed");
  });
});
