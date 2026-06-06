import { describe, expect, it } from "bun:test";
import { extractJsonObject } from "./llm-json.ts";

describe("extractJsonObject", () => {
  it("чистый объект", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it("в code-fence ```json", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("со <think>-преамбулой", () => {
    expect(extractJsonObject('<think>рассуждаю...</think>{"ok":true}')).toEqual({ ok: true });
  });
  it("встроенный объект среди прозы", () => {
    expect(extractJsonObject('Ответ: {"winner":"a"} — готово')).toEqual({ winner: "a" });
  });
  it("массив → null (нужен объект)", () => {
    expect(extractJsonObject("[1,2,3]")).toBeNull();
  });
  it("не строка → null", () => {
    expect(extractJsonObject(123 as unknown as string)).toBeNull();
  });
  it("мусор без {} → null", () => {
    expect(extractJsonObject("просто текст")).toBeNull();
  });
});
