import { describe, expect, test } from "bun:test";
import {
  applyStyleRules,
  capitalizeFirstLetter,
  DEFAULT_STYLE_RULES,
  replaceEllipsis,
  replaceEmDash,
  replaceEnDash,
  replaceOtherDashes,
  stripAILeadIns,
  stripMarkdownBold,
  stripMarkdownCode,
  stripMarkdownHeaders,
  stripMarkdownItalic,
  stripMarkdownLinks,
  type TextStyleRule,
} from "../src/text-style-rules.ts";

describe("dash normalization", () => {
  test("replaceEmDash converts U+2014 to a hyphen", () => {
    expect(replaceEmDash.apply("зарплата — высокая")).toBe("зарплата - высокая");
  });

  test("replaceEnDash converts U+2013 to a hyphen", () => {
    expect(replaceEnDash.apply("10:00–18:00")).toBe("10:00 - 18:00");
  });

  test("replaceOtherDashes converts horizontal bar and figure dash", () => {
    expect(replaceOtherDashes.apply("a―b")).toBe("a - b");
    expect(replaceOtherDashes.apply("a‒b")).toBe("a - b");
  });

  test("replaceEllipsis converts U+2026 to three dots", () => {
    expect(replaceEllipsis.apply("ну…")).toBe("ну...");
  });
});

describe("stripAILeadIns", () => {
  test("removes a ChatGPT-style opener and restores capitalization", () => {
    expect(stripAILeadIns.apply("Конечно! привет")).toBe("Привет");
  });

  test("leaves a normal answer untouched", () => {
    expect(stripAILeadIns.apply("Зарплата от 1500")).toBe("Зарплата от 1500");
  });

  test("keeps the original when stripping would empty the string", () => {
    expect(stripAILeadIns.apply("Конечно!")).toBe("Конечно!");
  });
});

describe("capitalizeFirstLetter", () => {
  test("uppercases the first alphabetic character", () => {
    expect(capitalizeFirstLetter.apply("привет")).toBe("Привет");
  });

  test("skips leading punctuation and whitespace", () => {
    expect(capitalizeFirstLetter.apply("  - ответ")).toBe("  - Ответ");
  });

  test("is a no-op when already capitalized", () => {
    expect(capitalizeFirstLetter.apply("Привет")).toBe("Привет");
  });
});

describe("markdown stripping", () => {
  test("stripMarkdownBold unwraps ** and __", () => {
    expect(stripMarkdownBold.apply("цена **₩110 000** в месяц")).toBe("цена ₩110 000 в месяц");
    expect(stripMarkdownBold.apply("__важно__")).toBe("важно");
  });

  test("stripMarkdownItalic unwraps * and _ but keeps URLs and snake_case", () => {
    expect(stripMarkdownItalic.apply("это *важно*")).toBe("это важно");
    expect(stripMarkdownItalic.apply("foo_bar")).toBe("foo_bar");
  });

  test("stripMarkdownCode unwraps inline and fenced code", () => {
    expect(stripMarkdownCode.apply("сумма `₩110`")).toBe("сумма ₩110");
    expect(stripMarkdownCode.apply("```\ntext\n```")).toBe("text\n");
  });

  test("stripMarkdownHeaders removes leading hashes", () => {
    expect(stripMarkdownHeaders.apply("## Условия:")).toBe("Условия:");
  });

  test("stripMarkdownLinks rewrites [text](url) to text (url)", () => {
    expect(stripMarkdownLinks.apply("[сайт](https://example.com)")).toBe(
      "сайт (https://example.com)",
    );
  });
});

describe("rule invariants", () => {
  const samples = [
    "Конечно! текст — с *разметкой* и …",
    "## Заголовок **жирный** `код` [ссылка](https://x.io)",
    "10:00–18:00 ― обычный текст",
  ];

  for (const rule of DEFAULT_STYLE_RULES) {
    test(`${rule.name} is idempotent`, () => {
      for (const s of samples) {
        const once = rule.apply(s);
        expect(rule.apply(once)).toBe(once);
      }
    });
  }
});

describe("applyStyleRules", () => {
  test("returns the input unchanged for an empty rule set", () => {
    expect(applyStyleRules("Конечно! текст", [])).toBe("Конечно! текст");
  });

  test("applies rules in order: lead-in stripped before re-capitalization", () => {
    expect(applyStyleRules("Конечно! привет")).toBe("Привет");
  });

  test("runs the full default bundle on mixed input", () => {
    const out = applyStyleRules("## Условия — оплата **высокая**…");
    expect(out).not.toContain("##");
    expect(out).not.toContain("**");
    expect(out).not.toContain("—");
    expect(out).not.toContain("…");
  });

  test("threads each rule's output into the next", () => {
    const rules: TextStyleRule[] = [
      { name: "a", description: "", apply: (s) => s.replace(/a/g, "b") },
      { name: "b", description: "", apply: (s) => s.replace(/b/g, "c") },
    ];
    expect(applyStyleRules("a", rules)).toBe("c");
  });
});
