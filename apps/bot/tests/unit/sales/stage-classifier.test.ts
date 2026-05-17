import { describe, expect, test } from "bun:test";

import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import { classifyStage, parseClassifierOutput } from "@/sales/stage-classifier.ts";

interface CallRecord {
  messages: ChatMessage[];
  options: { temperature?: number };
}

function captureChat(reply: string | Error): {
  client: ChatClient;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const client: ChatClient = {
    async complete(messages, opts = {}) {
      calls.push({ messages: messages.slice(), options: opts });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { client, calls };
}

describe("parseClassifierOutput", () => {
  test("parses a clean JSON object", () => {
    const out = parseClassifierOutput('{"stage": "pitch", "confidence": 0.85}');
    expect(out).toEqual({ stage: "pitch", confidence: 0.85 });
  });

  test("strips markdown code fences (```json ... ```)", () => {
    const out = parseClassifierOutput('```json\n{"stage": "qualify", "confidence": 0.9}\n```');
    expect(out).toEqual({ stage: "qualify", confidence: 0.9 });
  });

  test("ignores leading prose before the JSON", () => {
    const out = parseClassifierOutput(
      'Ответ: вот мой результат — {"stage": "objection", "confidence": 0.8}',
    );
    expect(out).toEqual({ stage: "objection", confidence: 0.8 });
  });

  test("ignores trailing prose after the JSON", () => {
    const out = parseClassifierOutput(
      '{"stage": "close", "confidence": 0.95} — это потому что клиент готов',
    );
    expect(out).toEqual({ stage: "close", confidence: 0.95 });
  });

  test("rescales confidence > 1 (e.g. 95 → 0.95)", () => {
    const out = parseClassifierOutput('{"stage": "pitch", "confidence": 95}');
    expect(out?.confidence).toBe(0.95);
  });

  test("clamps negative confidence to 0", () => {
    const out = parseClassifierOutput('{"stage": "pitch", "confidence": -0.1}');
    expect(out?.confidence).toBe(0);
  });

  test("returns null for non-JSON output", () => {
    expect(parseClassifierOutput("я думаю что это pitch")).toBeNull();
  });

  test("returns null when stage is missing", () => {
    expect(parseClassifierOutput('{"confidence": 0.9}')).toBeNull();
  });

  test("returns null when confidence is missing", () => {
    expect(parseClassifierOutput('{"stage": "pitch"}')).toBeNull();
  });

  test("returns null when confidence is non-numeric", () => {
    expect(parseClassifierOutput('{"stage": "pitch", "confidence": "high"}')).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseClassifierOutput("")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseClassifierOutput('{"stage": "pitch", "confidence": 0.9')).toBeNull();
  });
});

describe("classifyStage — happy path (LLM accepted)", () => {
  test("returns LLM stage when confidence above threshold", async () => {
    const { client, calls } = captureChat('{"stage": "pitch", "confidence": 0.85}');
    const out = await classifyStage({
      chat: client,
      userMessage: "сколько в Дубае платят?",
      currentStage: "qualify",
      turnNumber: 3,
    });
    expect(out.stage).toBe("pitch");
    expect(out.confidence).toBe(0.85);
    expect(out.source).toBe("llm");
    expect(out.fallbackReason).toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0]!.options.temperature).toBe(0); // deterministic classification
  });

  test("system prompt mentions all 5 stages", async () => {
    const { client, calls } = captureChat('{"stage":"opener","confidence":0.9}');
    await classifyStage({
      chat: client,
      userMessage: "привет",
      currentStage: null,
      turnNumber: 1,
    });
    const sys = calls[0]!.messages[0]!.content;
    expect(sys).toContain("opener");
    expect(sys).toContain("qualify");
    expect(sys).toContain("pitch");
    expect(sys).toContain("objection");
    expect(sys).toContain("close");
  });

  test("user prompt includes current stage and turn number", async () => {
    const { client, calls } = captureChat('{"stage":"qualify","confidence":0.9}');
    await classifyStage({
      chat: client,
      userMessage: "ну расскажи",
      currentStage: "opener",
      turnNumber: 5,
    });
    const user = calls[0]!.messages[1]!.content;
    expect(user).toContain("opener"); // prev stage
    expect(user).toContain("5"); // turn number
    expect(user).toContain("ну расскажи"); // user message
  });

  test("custom confidence threshold respected", async () => {
    // Threshold 0.8, LLM returns 0.7 → should fall back.
    const { client } = captureChat('{"stage":"close","confidence":0.7}');
    const out = await classifyStage({
      chat: client,
      userMessage: "ок",
      currentStage: "qualify",
      turnNumber: 3,
      confidenceThreshold: 0.8,
    });
    expect(out.source).toBe("regex-fallback");
    expect(out.fallbackReason).toBe("low-confidence");
    expect(out.confidence).toBe(0.7);
    // Regex would route "ок" + currentStage=qualify → close.
    expect(out.stage).toBe("close");
  });
});

describe("classifyStage — fallback paths", () => {
  test("LLM throws → regex fallback with reason='llm-error'", async () => {
    const { client } = captureChat(new Error("LLM exploded"));
    const out = await classifyStage({
      chat: client,
      userMessage: "сколько в Дубае платят?",
      currentStage: "qualify",
      turnNumber: 3,
    });
    expect(out.source).toBe("regex-fallback");
    expect(out.fallbackReason).toBe("llm-error");
    expect(out.confidence).toBe(0);
    // Regex should pick "pitch" for pricing keyword.
    expect(out.stage).toBe("pitch");
  });

  test("LLM returns garbage → reason='parse-error'", async () => {
    const { client } = captureChat("я думаю что это pitch, но не уверен");
    const out = await classifyStage({
      chat: client,
      userMessage: "сколько в Дубае платят?",
      currentStage: "qualify",
      turnNumber: 3,
    });
    expect(out.source).toBe("regex-fallback");
    expect(out.fallbackReason).toBe("parse-error");
    expect(out.stage).toBe("pitch");
  });

  test("LLM returns unknown stage → reason='unknown-stage'", async () => {
    const { client } = captureChat('{"stage": "made-up-stage", "confidence": 0.9}');
    const out = await classifyStage({
      chat: client,
      userMessage: "сколько в Дубае платят?",
      currentStage: "qualify",
      turnNumber: 3,
    });
    expect(out.source).toBe("regex-fallback");
    expect(out.fallbackReason).toBe("unknown-stage");
    expect(out.confidence).toBe(0.9); // confidence preserved for the log
    expect(out.stage).toBe("pitch"); // regex
  });

  test("LLM confidence below default threshold (0.6) → reason='low-confidence'", async () => {
    const { client } = captureChat('{"stage":"close","confidence":0.4}');
    const out = await classifyStage({
      chat: client,
      userMessage: "сколько в Дубае платят?",
      currentStage: "qualify",
      turnNumber: 3,
    });
    expect(out.source).toBe("regex-fallback");
    expect(out.fallbackReason).toBe("low-confidence");
    expect(out.confidence).toBe(0.4);
    expect(out.stage).toBe("pitch"); // regex
  });
});

describe("classifyStage — fallback never throws", () => {
  test("returns valid FunnelStage even when everything fails", async () => {
    const { client } = captureChat(new Error("network error"));
    const out = await classifyStage({
      chat: client,
      userMessage: "qzqxz", // gibberish, no regex match either
      currentStage: null,
      turnNumber: 1,
    });
    // Even on total failure regex returns "opener" for turn 1.
    expect(out.stage).toBe("opener");
    expect(out.source).toBe("regex-fallback");
  });

  test("handles empty user message gracefully", async () => {
    const { client } = captureChat('{"stage":"opener","confidence":0.9}');
    const out = await classifyStage({
      chat: client,
      userMessage: "",
      currentStage: null,
      turnNumber: 1,
    });
    expect(out.stage).toBe("opener");
  });
});
