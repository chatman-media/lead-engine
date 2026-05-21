import { describe, expect, it } from "bun:test";
import { parseAllocation } from "./dal/experiments.ts";

describe("parseAllocation", () => {
  it("парсит валидный JSON-массив", () => {
    const out = parseAllocation('[{"style_slug":"a","weight":2},{"style_slug":"b","weight":1}]');
    expect(out).toEqual([
      { styleSlug: "a", weight: 2 },
      { styleSlug: "b", weight: 1 },
    ]);
  });

  it("default weight = 1 если не указан", () => {
    const out = parseAllocation('[{"style_slug":"a"},{"style_slug":"b","weight":3}]');
    expect(out).toEqual([
      { styleSlug: "a", weight: 1 },
      { styleSlug: "b", weight: 3 },
    ]);
  });

  it("принимает оба варианта camelCase / snake_case ключа", () => {
    const out = parseAllocation('[{"styleSlug":"x","weight":1}]');
    expect(out).toEqual([{ styleSlug: "x", weight: 1 }]);
  });

  it("skip'ает entry без style_slug", () => {
    const out = parseAllocation('[{"weight":2},{"style_slug":"a"}]');
    expect(out).toEqual([{ styleSlug: "a", weight: 1 }]);
  });

  it("отрицательный/нулевой weight нормализуется к 1", () => {
    const out = parseAllocation('[{"style_slug":"a","weight":-5},{"style_slug":"b","weight":0}]');
    expect(out).toEqual([
      { styleSlug: "a", weight: 1 },
      { styleSlug: "b", weight: 1 },
    ]);
  });

  it("бросает при invalid JSON", () => {
    expect(() => parseAllocation("not json")).toThrow(/invalid/);
  });

  it("бросает если top-level не array", () => {
    expect(() => parseAllocation('{"style_slug":"a"}')).toThrow(/array/);
  });

  it("бросает если ни одной валидной entry", () => {
    expect(() => parseAllocation('[{"weight":1}]')).toThrow(/no valid entries/);
    expect(() => parseAllocation("[]")).toThrow(/no valid entries/);
  });
});
