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
  type TextStyleRule,
} from "@/rag/text-style-rules.ts";

describe("replaceEmDash", () => {
  test("replaces typographic em-dash with hyphen, normalising spaces", () => {
    expect(replaceEmDash.apply("Привет — рад тебя видеть")).toBe(
      "Привет - рад тебя видеть",
    );
  });

  test("handles em-dash without surrounding spaces", () => {
    expect(replaceEmDash.apply("шесть—семь часов")).toBe("шесть - семь часов");
  });

  test("handles multiple em-dashes in one line", () => {
    expect(replaceEmDash.apply("раз — два — три — четыре")).toBe(
      "раз - два - три - четыре",
    );
  });

  test("idempotent (running twice gives the same result)", () => {
    const once = replaceEmDash.apply("a — b — c");
    const twice = replaceEmDash.apply(once);
    expect(twice).toBe(once);
  });

  test("no-op when no em-dash present", () => {
    expect(replaceEmDash.apply("обычный текст с дефисом-другим")).toBe(
      "обычный текст с дефисом-другим",
    );
  });

  test("doesn't collapse single spaces in normal text", () => {
    // Without em-dash the apply path still hits the `  +` collapser.
    // Verify it doesn't eat single spaces.
    expect(replaceEmDash.apply("два слова и три слова")).toBe(
      "два слова и три слова",
    );
  });
});

describe("replaceEnDash", () => {
  test("replaces en-dash with hyphen", () => {
    expect(replaceEnDash.apply("10:00–18:00")).toBe("10:00 - 18:00");
  });

  test("idempotent", () => {
    const once = replaceEnDash.apply("a–b");
    expect(replaceEnDash.apply(once)).toBe(once);
  });
});

describe("replaceOtherDashes", () => {
  test("replaces horizontal bar (U+2015) and figure dash (U+2012)", () => {
    expect(replaceOtherDashes.apply("a―b")).toBe("a - b");
    expect(replaceOtherDashes.apply("c‒d")).toBe("c - d");
  });
});

describe("replaceEllipsis", () => {
  test("converts unicode ellipsis to three ASCII dots", () => {
    expect(replaceEllipsis.apply("Минуточку…")).toBe("Минуточку...");
  });

  test("idempotent", () => {
    expect(replaceEllipsis.apply("Минуточку...")).toBe("Минуточку...");
  });
});

describe("stripAILeadIns", () => {
  test("removes 'Конечно!' opener and uppercases the next word", () => {
    expect(stripAILeadIns.apply("Конечно! давай расскажу.")).toBe(
      "Давай расскажу.",
    );
  });

  test("removes 'Безусловно,' opener", () => {
    expect(stripAILeadIns.apply("Безусловно, могу помочь")).toBe(
      "Могу помочь",
    );
  });

  test("removes 'Отлично!' / 'Разумеется!' / 'Хорошо!'", () => {
    expect(stripAILeadIns.apply("Отлично! приступим.")).toBe("Приступим.");
    expect(stripAILeadIns.apply("Разумеется. поясню")).toBe("Поясню");
    expect(stripAILeadIns.apply("Хорошо, расскажу")).toBe("Расскажу");
  });

  test("doesn't strip if it would empty the reply", () => {
    expect(stripAILeadIns.apply("Конечно!")).toBe("Конечно!");
  });

  test("doesn't strip mid-sentence occurrences", () => {
    expect(stripAILeadIns.apply("Это конечно неудобно")).toBe(
      "Это конечно неудобно",
    );
  });

  test("idempotent", () => {
    const once = stripAILeadIns.apply("Конечно! помогу с этим.");
    expect(stripAILeadIns.apply(once)).toBe(once);
  });
});

describe("capitalizeFirstLetter", () => {
  test("uppercases the first alphabetic character (Cyrillic)", () => {
    expect(capitalizeFirstLetter.apply("привет, как дела?")).toBe(
      "Привет, как дела?",
    );
  });

  test("uppercases the first alphabetic character (Latin)", () => {
    expect(capitalizeFirstLetter.apply("hello there")).toBe("Hello there");
  });

  test("skips leading whitespace", () => {
    expect(capitalizeFirstLetter.apply("   привет!")).toBe("   Привет!");
  });

  test("skips leading emoji and punctuation", () => {
    expect(capitalizeFirstLetter.apply("🔥 привет!")).toBe("🔥 Привет!");
    expect(capitalizeFirstLetter.apply("❗️ работа в Дубае")).toBe(
      "❗️ Работа в Дубае",
    );
  });

  test("idempotent (already-capitalised → no-op)", () => {
    expect(capitalizeFirstLetter.apply("Привет!")).toBe("Привет!");
  });

  test("no-op on empty string", () => {
    expect(capitalizeFirstLetter.apply("")).toBe("");
  });

  test("no-op on string without letters (numbers/symbols only)", () => {
    expect(capitalizeFirstLetter.apply("123 !@#")).toBe("123 !@#");
  });

  test("only the first letter is touched, rest preserved as-is", () => {
    expect(
      capitalizeFirstLetter.apply("привет КАК дела УРА"),
    ).toBe("Привет КАК дела УРА");
  });
});

describe("applyStyleRules — DEFAULT_STYLE_RULES bundle", () => {
  test("compounds across rules (em-dash + ellipsis + lead-in + capital)", () => {
    expect(
      applyStyleRules("Конечно! сейчас расскажу — там много нюансов…"),
    ).toBe("Сейчас расскажу - там много нюансов...");
  });

  test("lowercase-first-letter user reply gets capitalised", () => {
    expect(applyStyleRules("привет, как дела?")).toBe("Привет, как дела?");
  });

  test("real-world LLM lowercase reply becomes natural Russian chat style", () => {
    const aiOutput =
      "привет! работа в китае — в топ-клубах шаосин и иу. график: 6 дней в неделю.";
    expect(applyStyleRules(aiOutput)).toBe(
      "Привет! работа в китае - в топ-клубах шаосин и иу. график: 6 дней в неделю.",
    );
    // Note: only sentence-start capitalisation (first letter of reply) is
    // enforced. Mid-reply «работа», «график» stay lowercase — real-world
    // Russian chat doesn't reliably capitalise after every period either.
  });

  test("idempotent across the whole bundle", () => {
    const input = "Безусловно! 10:00–18:00 — стандартный график…";
    const once = applyStyleRules(input);
    const twice = applyStyleRules(once);
    expect(twice).toBe(once);
  });

  test("plain text passes through unchanged", () => {
    const plain = "В Дубае гонорар $3000-8000/мес. Контракт от 1 до 3 месяцев.";
    expect(applyStyleRules(plain)).toBe(plain);
  });

  test("real LLM-style reply gets cleaned end-to-end", () => {
    const aiOutput =
      "Конечно! у нас контракт в Дубае — от 1 до 3 месяцев, гонорар $3000–$8000/мес… Условия отличные, никаких скрытых платежей.";
    const cleaned = applyStyleRules(aiOutput);
    expect(cleaned).not.toMatch(/—|–|…|^Конечно/);
    expect(cleaned).toContain("$3000 - $8000");
    expect(cleaned).toContain("...");
    expect(cleaned[0]).toBe("У"); // capital после strip
  });

  test("custom rule list — caller can override default bundle", () => {
    const onlyEmDash: TextStyleRule[] = [replaceEmDash];
    expect(applyStyleRules("Привет — мир…", onlyEmDash)).toBe("Привет - мир…");
  });

  test("empty rule list returns input unchanged", () => {
    expect(applyStyleRules("Конечно! — …", [])).toBe("Конечно! — …");
  });
});

describe("DEFAULT_STYLE_RULES — registry sanity", () => {
  test("each rule has a unique non-empty name and description", () => {
    const names = new Set<string>();
    for (const rule of DEFAULT_STYLE_RULES) {
      expect(rule.name.length).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(0);
      expect(names.has(rule.name)).toBe(false);
      names.add(rule.name);
    }
    expect(DEFAULT_STYLE_RULES.length).toBeGreaterThanOrEqual(4);
  });

  test("ordering: stripAILeadIns runs BEFORE capitalizeFirstLetter", () => {
    // Otherwise «Конечно! привет» would become «Конечно! привет» (capital К
    // already, lead-in stripper sees «Конечно!» and removes it, but only if
    // it RUNS AFTER capitalizer's no-op — verify the order in the array).
    const stripIdx = DEFAULT_STYLE_RULES.findIndex(
      (r) => r.name === "strip-ai-lead-ins",
    );
    const capIdx = DEFAULT_STYLE_RULES.findIndex(
      (r) => r.name === "capitalize-first-letter",
    );
    expect(stripIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(stripIdx);
  });
});
