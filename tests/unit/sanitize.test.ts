import { describe, expect, test } from "bun:test";

import { sanitizeLlmOutput, stripCodeFences, stripThinkBlocks } from "@/rag/sanitize.ts";

describe("stripThinkBlocks", () => {
  test("removes a well-formed paired <think> block", () => {
    expect(stripThinkBlocks("<think>reasoning here</think>Привет")).toBe("Привет");
  });

  test("removes a paired block with attributes and across newlines", () => {
    const raw = '<think id="1">\nmulti\nline\n</think>ответ';
    expect(stripThinkBlocks(raw)).toBe("ответ");
  });

  test("removes an unclosed leading <think> block", () => {
    expect(stripThinkBlocks("  <think>reasoning that never closes")).toBe("");
  });

  test("leaves text without think blocks untouched", () => {
    expect(stripThinkBlocks("обычный ответ")).toBe("обычный ответ");
  });
});

describe("stripCodeFences", () => {
  test("removes plain triple-backtick fences", () => {
    expect(stripCodeFences("```\n{}\n```")).toBe("\n{}\n");
  });

  test("removes ```json fences", () => {
    expect(stripCodeFences('```json{"a":1}```')).toBe('{"a":1}');
  });
});

describe("sanitizeLlmOutput", () => {
  test("strips think blocks, leading label and trims", () => {
    expect(sanitizeLlmOutput("<think>x</think>  Ответ: всё хорошо  ")).toBe("Всё хорошо");
  });

  test("strips an English 'Answer:' prefix", () => {
    expect(sanitizeLlmOutput("Answer: hello")).toBe("Hello");
  });

  test("strips the 'Согласно контексту' prefix", () => {
    expect(sanitizeLlmOutput("Согласно контексту — зарплата высокая")).toBe("Зарплата высокая");
  });

  test("applies text-style rules (em-dash normalisation)", () => {
    expect(sanitizeLlmOutput("зарплата — хорошая")).toBe("Зарплата - хорошая");
  });

  test("strips AI lead-ins and re-capitalises", () => {
    expect(sanitizeLlmOutput("Конечно! расскажу подробнее")).toBe("Расскажу подробнее");
  });

  test("is idempotent on already-clean output", () => {
    const clean = sanitizeLlmOutput("Готово, всё в порядке");
    expect(sanitizeLlmOutput(clean)).toBe(clean);
  });
});
