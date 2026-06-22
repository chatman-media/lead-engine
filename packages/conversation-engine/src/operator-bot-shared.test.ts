import { describe, expect, it } from "bun:test";
import {
  escapeHtml,
  objectValue,
  parseJsonObject,
  pickupWindowFromDestination,
  stringValue,
} from "./operator-bot-shared.ts";

describe("escapeHtml", () => {
  it("экранирует html-спецсимволы", () => {
    expect(escapeHtml(`<b>"&'</b>`)).toBe("&lt;b&gt;&quot;&amp;&#39;&lt;/b&gt;");
  });
});

describe("parseJsonObject", () => {
  it("валидный объект", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it("null/пусто/массив/мусор → {}", () => {
    expect(parseJsonObject(null)).toEqual({});
    expect(parseJsonObject("")).toEqual({});
    expect(parseJsonObject("[1,2]")).toEqual({});
    expect(parseJsonObject("{broken")).toEqual({});
  });
});

describe("stringValue / objectValue", () => {
  it("stringValue: непустая строка → trim, иначе null", () => {
    expect(stringValue("  x ")).toBe("x");
    expect(stringValue("   ")).toBeNull();
    expect(stringValue(42)).toBeNull();
  });
  it("objectValue: объект → он сам, иначе {}", () => {
    expect(objectValue({ a: 1 })).toEqual({ a: 1 });
    expect(objectValue([1])).toEqual({});
    expect(objectValue(null)).toEqual({});
  });
});

describe("pickupWindowFromDestination", () => {
  it("достаёт окно из разных ключей", () => {
    expect(pickupWindowFromDestination('{"pickupWindow":"10-12"}')).toBe("10-12");
    expect(pickupWindowFromDestination('{"slot":"14-16"}')).toBe("14-16");
  });
  it("пусто/битый JSON/без окна → null", () => {
    expect(pickupWindowFromDestination(null)).toBeNull();
    expect(pickupWindowFromDestination("{broken")).toBeNull();
    expect(pickupWindowFromDestination('{"x":1}')).toBeNull();
  });
});
