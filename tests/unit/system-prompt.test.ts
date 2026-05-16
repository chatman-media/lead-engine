import { describe, expect, test } from "bun:test";

import { NO_CONTEXT_MARKER, type Persona } from "@/rag/answer-types.ts";
import {
  buildSystemPrompt,
  DEFAULT_PERSONA,
  legacyRagSamplingTemperature,
  renderSummaryBlock,
  renderUserFactsBlock,
} from "@/rag/system-prompt.ts";

describe("renderSummaryBlock", () => {
  test("returns '' for undefined summary", () => {
    expect(renderSummaryBlock(undefined)).toBe("");
  });

  test("returns '' for a whitespace-only summary", () => {
    expect(renderSummaryBlock("   \n  ")).toBe("");
  });

  test("renders a heading + trimmed summary", () => {
    const out = renderSummaryBlock("  обсудили зарплату  ");
    expect(out).toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
    expect(out).toContain("обсудили зарплату");
    expect(out).not.toContain("  обсудили");
  });
});

describe("renderUserFactsBlock", () => {
  test("returns '' for undefined facts", () => {
    expect(renderUserFactsBlock(undefined)).toBe("");
  });

  test("returns '' when every value is blank", () => {
    expect(renderUserFactsBlock({ city: "  ", age: "" })).toBe("");
  });

  test("renders only non-blank entries", () => {
    const out = renderUserFactsBlock({ city: "Ташкент", age: "  ", intent: "виза" });
    expect(out).toContain("ЗНАЕМ О КАНДИДАТЕ");
    expect(out).toContain("- city: Ташкент");
    expect(out).toContain("- intent: виза");
    expect(out).not.toContain("age");
  });
});

describe("buildSystemPrompt", () => {
  test("human persona forbids revealing it is an AI", () => {
    const persona: Persona = { name: "Алина", role: "human", company: "ALINA" };
    const out = buildSystemPrompt(persona, "CTX");
    expect(out).toContain("Алина");
    expect(out).toContain("ALINA");
    expect(out).toContain("НИКОГДА не упоминай");
  });

  test("assistant persona openly identifies as an AI assistant", () => {
    const persona: Persona = { name: "Бот", role: "assistant" };
    const out = buildSystemPrompt(persona, "CTX");
    expect(out).toContain("ИИ-ассистент");
  });

  test("always embeds the no-context marker and the CONTEXT section", () => {
    const out = buildSystemPrompt(DEFAULT_PERSONA, "сведения о вакансии");
    expect(out).toContain(NO_CONTEXT_MARKER);
    expect(out).toContain("CONTEXT:\nсведения о вакансии");
  });

  test("includes a personal-facts block when persona.facts is set", () => {
    const persona: Persona = {
      name: "Алина",
      role: "human",
      facts: { city: "Сеул", age: "  " },
    };
    const out = buildSystemPrompt(persona, "CTX");
    expect(out).toContain("ЛИЧНЫЕ ФАКТЫ");
    expect(out).toContain("- city: Сеул");
    expect(out).not.toContain("- age:");
  });

  test("appends user-facts and conversation-summary blocks", () => {
    const out = buildSystemPrompt(
      DEFAULT_PERSONA,
      "CTX",
      { city: "Алматы" },
      "ранее обсуждали график",
    );
    expect(out).toContain("ЗНАЕМ О КАНДИДАТЕ");
    expect(out).toContain("Алматы");
    expect(out).toContain("ИЗ РАННЕЙ ПЕРЕПИСКИ");
    expect(out).toContain("ранее обсуждали график");
  });
});

describe("legacyRagSamplingTemperature", () => {
  test("returns a finite temperature for both persona roles", () => {
    const human = legacyRagSamplingTemperature({ name: "A", role: "human" });
    const assistant = legacyRagSamplingTemperature({ name: "B", role: "assistant" });
    expect(Number.isFinite(human)).toBe(true);
    expect(Number.isFinite(assistant)).toBe(true);
    expect(human).toBeGreaterThanOrEqual(0);
    expect(assistant).toBeGreaterThanOrEqual(0);
  });
});
