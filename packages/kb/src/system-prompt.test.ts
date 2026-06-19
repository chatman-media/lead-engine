// Unit tests for the legacy (non-style) system-prompt builder and its block
// renderers. Pure functions — no fakes needed.

import { describe, expect, it } from "bun:test";
import {
  buildSystemPrompt,
  DEFAULT_PERSONA,
  legacyRagSamplingTemperature,
  renderSummaryBlock,
  renderUserFactsBlock,
} from "./system-prompt.ts";

describe("legacyRagSamplingTemperature", () => {
  it("human → 0.55, assistant → 0.38", () => {
    expect(legacyRagSamplingTemperature({ name: "x", role: "human" })).toBe(0.55);
    expect(legacyRagSamplingTemperature({ name: "x", role: "assistant" })).toBe(0.38);
  });
  it("override имеет приоритет", () => {
    expect(legacyRagSamplingTemperature(DEFAULT_PERSONA, 0.9)).toBe(0.9);
  });
});

describe("renderSummaryBlock", () => {
  it("пусто/whitespace → ''", () => {
    expect(renderSummaryBlock()).toBe("");
    expect(renderSummaryBlock("   ")).toBe("");
  });
  it("с текстом → блок «ИЗ РАННЕЙ ПЕРЕПИСКИ»", () => {
    expect(renderSummaryBlock("обсудили визу")).toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
  });
});

describe("renderUserFactsBlock", () => {
  it("undefined / только пустые значения → ''", () => {
    expect(renderUserFactsBlock()).toBe("");
    expect(renderUserFactsBlock({ city: "  " })).toBe("");
  });
  it("факты → bullet-список", () => {
    const b = renderUserFactsBlock({ city: "Москва", age: "25" });
    expect(b).toContain("- city: Москва");
    expect(b).toContain("- age: 25");
  });
});

describe("buildSystemPrompt", () => {
  it("human persona: НИКОГДА не говори что ты ИИ + компания", () => {
    const p = buildSystemPrompt({ name: "Аня", role: "human", company: "Acme" }, "CTX");
    expect(p).toContain("Аня");
    expect(p).toContain("Acme");
    expect(p).toContain("НИКОГДА");
    expect(p).toContain("ЖИВАЯ РЕЧЬ");
    expect(p).toContain("CONTEXT:\nCTX");
  });

  it("assistant persona: ИИ-ассистент, без блока живой речи", () => {
    const p = buildSystemPrompt({ name: "Бот", role: "assistant" }, "CTX");
    expect(p).toContain("ИИ-ассистент");
    expect(p).not.toContain("ЖИВАЯ РЕЧЬ");
  });

  it("instructs grounding on cross-language CONTEXT and gender-neutral self-reference", () => {
    const p = buildSystemPrompt({ name: "Бот", role: "assistant" }, "CTX");
    // Кросс-язык: EN-источник не должен валиться в NO_CONTEXT только из-за языка.
    expect(p).toContain("на ДРУГОМ ЯЗЫКЕ");
    // Нейтральный род: не «посчитал»/«готов», а нейтральные формы.
    expect(p).toContain("краткие прилагательные");
  });

  it("lang-параметр (#730): директива на языке ответа, дефолт ru (back-compat)", () => {
    // Дефолт без аргумента — русский (back-compat).
    const ru = buildSystemPrompt({ name: "Бот", role: "assistant" }, "CTX");
    expect(ru).toContain("на языке ответа (русском)");
    // Явный корейский: директива на 한국어, без «русском».
    const ko = buildSystemPrompt(
      { name: "Бот", role: "assistant" },
      "CTX",
      undefined,
      undefined,
      "ko",
    );
    expect(ko).toContain("на языке ответа (한국어)");
    expect(ko).not.toContain("(русском)");
  });

  it("persona.facts → блок ЛИЧНЫЕ ФАКТЫ (пустые отброшены)", () => {
    const p = buildSystemPrompt(
      { name: "Аня", role: "human", facts: { city: "Сочи", empty: "  " } },
      "CTX",
    );
    expect(p).toContain("ЛИЧНЫЕ ФАКТЫ");
    expect(p).toContain("city: Сочи");
    expect(p).not.toContain("empty");
  });

  it("userFacts + summary секции добавляются", () => {
    const p = buildSystemPrompt(
      { name: "x", role: "assistant" },
      "CTX",
      { age: "30" },
      "ранее обсудили",
    );
    expect(p).toContain("ЗНАЕМ О КАНДИДАТЕ");
    expect(p).toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
  });

  it("порядок под prompt-cache: СТРОГИЕ ПРАВИЛА перед summary/userFacts, CONTEXT — последний", () => {
    const p = buildSystemPrompt(
      { name: "x", role: "human", company: "Acme" },
      "CTX",
      { age: "30" },
      "ранее обсудили",
    );
    const rules = p.indexOf("СТРОГИЕ ПРАВИЛА");
    const summary = p.indexOf("ИЗ РАННЕЙ ПЕРЕПИСКИ");
    const facts = p.indexOf("ЗНАЕМ О КАНДИДАТЕ");
    const ctx = p.indexOf("CONTEXT:"); // финальная секция; «CONTEXT ниже» в правилах без двоеточия
    expect(rules).toBeGreaterThanOrEqual(0);
    // стабильные правила раньше волатильного хвоста
    expect(rules).toBeLessThan(summary);
    expect(rules).toBeLessThan(facts);
    // CONTEXT остаётся последним
    expect(ctx).toBeGreaterThan(summary);
    expect(ctx).toBeGreaterThan(facts);
  });
});
