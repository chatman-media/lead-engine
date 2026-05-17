import { describe, expect, test } from "bun:test";
import { extractJsonObject } from "../llm-json.ts";

describe("extractJsonObject", () => {
  test("parses a clean JSON object", () => {
    expect(extractJsonObject('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  test("strips a ```json code fence", () => {
    expect(extractJsonObject('```json\n{"ok":true}\n```')).toEqual({
      ok: true,
    });
  });

  test("strips a plain ``` code fence", () => {
    expect(extractJsonObject('```\n{"ok":false}\n```')).toEqual({ ok: false });
  });

  test("strips a leading <think> block", () => {
    const raw = '<think>reasoning here</think>\n{"stage":"pitch"}';
    expect(extractJsonObject(raw)).toEqual({ stage: "pitch" });
  });

  test("extracts the object from surrounding prose", () => {
    const raw = 'Ответ: {"winner":"a"} — надеюсь, помог';
    expect(extractJsonObject(raw)).toEqual({ winner: "a" });
  });

  test("returns null for prose with no JSON object", () => {
    expect(extractJsonObject("I cannot determine the outcome")).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(extractJsonObject("")).toBeNull();
  });

  test("returns null for a JSON array (objects only)", () => {
    expect(extractJsonObject("[1,2,3]")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(extractJsonObject('{"a": }')).toBeNull();
  });

  test("returns null for a non-string input", () => {
    expect(extractJsonObject(undefined as unknown as string)).toBeNull();
  });
});
