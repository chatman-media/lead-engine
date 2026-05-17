import { describe, expect, test } from "bun:test";
import type { ChatClient } from "@chatman-media/rag";
import { classifyStage, parseClassifierOutput } from "../stage-classifier.ts";

/** Minimal ChatClient whose `complete` returns (or throws) a fixed value. */
function stubChat(reply: string | (() => never)): ChatClient {
  return {
    async complete() {
      if (typeof reply === "function") return reply();
      return reply;
    },
  };
}

describe("parseClassifierOutput", () => {
  test("parses a clean object", () => {
    expect(parseClassifierOutput('{"stage":"pitch","confidence":0.9}')).toEqual(
      { stage: "pitch", confidence: 0.9 },
    );
  });

  test("strips a ```json code fence", () => {
    const raw = '```json\n{"stage":"qualify","confidence":0.8}\n```';
    expect(parseClassifierOutput(raw)).toEqual({
      stage: "qualify",
      confidence: 0.8,
    });
  });

  test("extracts the object past an 'Ответ:' prefix", () => {
    const raw = 'Ответ: {"stage":"close","confidence":0.7}';
    expect(parseClassifierOutput(raw)).toEqual({
      stage: "close",
      confidence: 0.7,
    });
  });

  test("clamps a percentage-style confidence (95 → 0.95)", () => {
    expect(parseClassifierOutput('{"stage":"pitch","confidence":95}')).toEqual({
      stage: "pitch",
      confidence: 0.95,
    });
  });

  test("returns null for malformed JSON", () => {
    expect(parseClassifierOutput("not json at all")).toBeNull();
  });

  test("returns null when stage field is missing", () => {
    expect(parseClassifierOutput('{"confidence":0.9}')).toBeNull();
  });

  test("returns null when confidence is not a number", () => {
    expect(
      parseClassifierOutput('{"stage":"pitch","confidence":"high"}'),
    ).toBeNull();
  });
});

describe("classifyStage — fallback paths", () => {
  const base = {
    userMessage: "сколько платят?",
    currentStage: "qualify" as const,
    turnNumber: 3,
  };

  test("LLM error → regex fallback with reason 'llm-error'", async () => {
    const result = await classifyStage({
      ...base,
      chat: stubChat(() => {
        throw new Error("network down");
      }),
    });
    expect(result.source).toBe("regex-fallback");
    expect(result.fallbackReason).toBe("llm-error");
  });

  test("unparseable output → reason 'parse-error'", async () => {
    const result = await classifyStage({
      ...base,
      chat: stubChat("I have no idea"),
    });
    expect(result.fallbackReason).toBe("parse-error");
  });

  test("unknown stage → reason 'unknown-stage'", async () => {
    const result = await classifyStage({
      ...base,
      chat: stubChat('{"stage":"smalltalk","confidence":0.9}'),
    });
    expect(result.fallbackReason).toBe("unknown-stage");
  });

  test("below-threshold confidence → reason 'low-confidence'", async () => {
    const result = await classifyStage({
      ...base,
      chat: stubChat('{"stage":"pitch","confidence":0.3}'),
    });
    expect(result.fallbackReason).toBe("low-confidence");
  });
});

describe("classifyStage — LLM path", () => {
  test("valid high-confidence verdict is taken as-is", async () => {
    const result = await classifyStage({
      userMessage: "сколько платят?",
      currentStage: "qualify",
      turnNumber: 3,
      chat: stubChat('{"stage":"pitch","confidence":0.92}'),
    });
    expect(result.source).toBe("llm");
    expect(result.stage).toBe("pitch");
    expect(result.confidence).toBe(0.92);
  });
});
