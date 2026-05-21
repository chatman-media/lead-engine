import { describe, expect, test } from "bun:test";
import { parseFactsFromLlmOutput } from "../src/extract-user-facts.ts";
import { parseFactCheckResult } from "../src/fact-checker.ts";
import { parseReflection } from "../src/reflect.ts";
import { sanitizeLlmOutput } from "../src/sanitize.ts";

describe("parseFactsFromLlmOutput", () => {
  test("parses a plain JSON object", () => {
    expect(parseFactsFromLlmOutput('{"name":"Аня","age":"23"}')).toEqual({
      name: "Аня",
      age: "23",
    });
  });

  test("strips code fences, think tags and prefixes", () => {
    const raw = 'Ответ:\n<think>reasoning</think>\n```json\n{"city":"Москва"}\n```';
    expect(parseFactsFromLlmOutput(raw)).toEqual({ city: "Москва" });
  });

  test("coerces non-string values to strings", () => {
    expect(parseFactsFromLlmOutput('{"age": 23}')).toEqual({ age: "23" });
  });

  test("returns an empty object when no JSON is present", () => {
    expect(parseFactsFromLlmOutput("no json here")).toEqual({});
  });
});

describe("parseFactCheckResult", () => {
  test("parses a grounded result", () => {
    expect(parseFactCheckResult('{"grounded": true, "vacancyOk": true}')).toEqual({
      grounded: true,
      vacancyOk: true,
    });
  });

  test("parses a failure with a reason", () => {
    expect(
      parseFactCheckResult('{"grounded": false, "vacancyOk": true, "reason": "invented salary"}'),
    ).toEqual({ grounded: false, vacancyOk: true, reason: "invented salary" });
  });

  test("fails open to grounded on unparseable input", () => {
    expect(parseFactCheckResult("garbage output")).toEqual({ grounded: true, vacancyOk: true });
  });
});

describe("parseReflection", () => {
  test("parses a grounded reflection", () => {
    expect(parseReflection('{"grounded": true}')).toEqual({ grounded: true });
  });

  test("parses an ungrounded reflection with a reason", () => {
    expect(parseReflection('{"grounded": false, "reason": "fabricated city"}')).toEqual({
      grounded: false,
      reason: "fabricated city",
    });
  });

  test("fails open to grounded on unparseable input", () => {
    expect(parseReflection("not json")).toEqual({ grounded: true });
  });
});

describe("sanitizeLlmOutput", () => {
  test("removes think blocks", () => {
    expect(sanitizeLlmOutput("<think>chain of thought</think>Final answer")).toBe("Final answer");
  });

  test("strips a leading answer prefix", () => {
    expect(sanitizeLlmOutput("Ответ: Привет")).toBe("Привет");
  });

  test("trims surrounding whitespace", () => {
    expect(sanitizeLlmOutput("  Hello there  ")).toBe("Hello there");
  });
});
