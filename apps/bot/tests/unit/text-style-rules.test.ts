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
} from "@/rag/text-style-rules.ts";

describe("replaceEmDash", () => {
  test("replaces typographic em-dash with hyphen, normalising spaces", () => {
    expect(replaceEmDash.apply("Привет — рад тебя видеть")).toBe("Привет - рад тебя видеть");
  });

  test("handles em-dash without surrounding spaces", () => {
    expect(replaceEmDash.apply("шесть—семь часов")).toBe("шесть - семь часов");
  });

  test("handles multiple em-dashes in one line", () => {
    expect(replaceEmDash.apply("раз — два — три — четыре")).toBe("раз - два - три - четыре");
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
    expect(replaceEmDash.apply("два слова и три слова")).toBe("два слова и три слова");
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
    expect(stripAILeadIns.apply("Конечно! давай расскажу.")).toBe("Давай расскажу.");
  });

  test("removes 'Безусловно,' opener", () => {
    expect(stripAILeadIns.apply("Безусловно, могу помочь")).toBe("Могу помочь");
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
    expect(stripAILeadIns.apply("Это конечно неудобно")).toBe("Это конечно неудобно");
  });

  test("idempotent", () => {
    const once = stripAILeadIns.apply("Конечно! помогу с этим.");
    expect(stripAILeadIns.apply(once)).toBe(once);
  });
});

describe("capitalizeFirstLetter", () => {
  test("uppercases the first alphabetic character (Cyrillic)", () => {
    expect(capitalizeFirstLetter.apply("привет, как дела?")).toBe("Привет, как дела?");
  });

  test("uppercases the first alphabetic character (Latin)", () => {
    expect(capitalizeFirstLetter.apply("hello there")).toBe("Hello there");
  });

  test("skips leading whitespace", () => {
    expect(capitalizeFirstLetter.apply("   привет!")).toBe("   Привет!");
  });

  test("skips leading emoji and punctuation", () => {
    expect(capitalizeFirstLetter.apply("🔥 привет!")).toBe("🔥 Привет!");
    expect(capitalizeFirstLetter.apply("❗️ работа в Дубае")).toBe("❗️ Работа в Дубае");
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
    expect(capitalizeFirstLetter.apply("привет КАК дела УРА")).toBe("Привет КАК дела УРА");
  });
});

describe("stripMarkdownBold", () => {
  test("strips ** wrappers, keeps inner text", () => {
    expect(stripMarkdownBold.apply("Зарплата от **₩110 000** в смену")).toBe(
      "Зарплата от ₩110 000 в смену",
    );
  });

  test("strips __ wrappers", () => {
    expect(stripMarkdownBold.apply("Это __очень__ важно")).toBe("Это очень важно");
  });

  test("idempotent", () => {
    const once = stripMarkdownBold.apply("**факт**: ставка от 10k");
    expect(stripMarkdownBold.apply(once)).toBe(once);
  });

  test("leaves text with no markdown intact", () => {
    expect(stripMarkdownBold.apply("обычный текст без звёздочек")).toBe(
      "обычный текст без звёздочек",
    );
  });

  test("does not eat lone '**' between non-content", () => {
    // Bare `** **` (whitespace-only inside) is not bold — leave it.
    const input = "перевод средств ** ** оформляется автоматом";
    expect(stripMarkdownBold.apply(input)).toBe(input);
  });
});

describe("stripMarkdownItalic", () => {
  test("strips * wrappers around words", () => {
    expect(stripMarkdownItalic.apply("это *важно* для тебя")).toBe("это важно для тебя");
  });

  test("strips _ wrappers around words", () => {
    expect(stripMarkdownItalic.apply("это _курсив_")).toBe("это курсив");
  });

  test("preserves underscores INSIDE identifiers (URLs, filenames)", () => {
    expect(stripMarkdownItalic.apply("https://example_site.com/file_name.md")).toBe(
      "https://example_site.com/file_name.md",
    );
    expect(stripMarkdownItalic.apply("обнови my_var и yet_another")).toBe(
      "обнови my_var и yet_another",
    );
  });

  test("preserves asterisks NOT acting as paired emphasis", () => {
    expect(stripMarkdownItalic.apply("ставка 5*5 = 25")).toBe("ставка 5*5 = 25");
  });

  test("strips italic at the start and end of string", () => {
    expect(stripMarkdownItalic.apply("*важно* — тут")).toBe("важно — тут");
    expect(stripMarkdownItalic.apply("в конце _важно_")).toBe("в конце важно");
  });
});

describe("stripMarkdownCode", () => {
  test("strips inline backticks", () => {
    expect(stripMarkdownCode.apply("оплата `₩110 000` за смену")).toBe("оплата ₩110 000 за смену");
  });

  test("strips fenced code blocks", () => {
    // The regex consumes the optional language line (incl. newline) after
    // the opening fence, so the content's leading newline collapses. Net
    // effect: fence delimiters drop, content keeps its own line breaks.
    expect(stripMarkdownCode.apply("вот:\n```\nстрока\n```\nконец")).toBe("вот:\nстрока\n\nконец");
  });

  test("strips fenced block with language hint", () => {
    expect(stripMarkdownCode.apply("```ts\nlet x = 1\n```")).toBe("let x = 1\n");
  });
});

describe("stripMarkdownHeaders", () => {
  test("strips leading # at line start", () => {
    expect(stripMarkdownHeaders.apply("# Условия\nставка")).toBe("Условия\nставка");
  });

  test("handles multiple levels", () => {
    expect(stripMarkdownHeaders.apply("## Корея\n### Шаохинг")).toBe("Корея\nШаохинг");
  });

  test("preserves # in the middle of a line", () => {
    expect(stripMarkdownHeaders.apply("звони +1 #1234")).toBe("звони +1 #1234");
  });
});

describe("stripMarkdownLinks", () => {
  test("converts [text](url) into 'text (url)'", () => {
    expect(stripMarkdownLinks.apply("читай [тут](https://t.me/x)")).toBe(
      "читай тут (https://t.me/x)",
    );
  });

  test("preserves plain URLs", () => {
    expect(stripMarkdownLinks.apply("ссылка https://t.me/x")).toBe("ссылка https://t.me/x");
  });
});

describe("applyStyleRules — DEFAULT_STYLE_RULES bundle", () => {
  test("compounds across rules (em-dash + ellipsis + lead-in + capital)", () => {
    expect(applyStyleRules("Конечно! сейчас расскажу — там много нюансов…")).toBe(
      "Сейчас расскажу - там много нюансов...",
    );
  });

  test("lowercase-first-letter user reply gets capitalised", () => {
    expect(applyStyleRules("привет, как дела?")).toBe("Привет, как дела?");
  });

  test("real-world LLM lowercase reply becomes natural Russian chat style", () => {
    const aiOutput = "привет! работа в китае — в топ-клубах шаосин и иу. график: 6 дней в неделю.";
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

  test("strips markdown that qwen3 actually emits (real reply from self-play)", () => {
    // Verbatim from a self-play match — qwen3 ignored the "no markdown"
    // instruction and emitted bold + italic emphasis. Telegram doesn't
    // render markdown by default, so the candidate sees raw asterisks.
    const aiOutput =
      "Корея — оплата **₩110 000** за смену + румки `₩1 500/час`. " +
      "Хочешь подробнее по [этой странице](https://t.me/infinity_agency_world/389)?";
    const cleaned = applyStyleRules(aiOutput);
    expect(cleaned).not.toContain("**");
    expect(cleaned).not.toContain("`");
    expect(cleaned).not.toContain("](");
    expect(cleaned).toContain("₩110 000");
    expect(cleaned).toContain("https://t.me/infinity_agency_world/389");
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
    const stripIdx = DEFAULT_STYLE_RULES.findIndex((r) => r.name === "strip-ai-lead-ins");
    const capIdx = DEFAULT_STYLE_RULES.findIndex((r) => r.name === "capitalize-first-letter");
    expect(stripIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(stripIdx);
  });
});
