import { describe, expect, test } from "bun:test";

import type { Persona } from "@/rag/answer-types.ts";
import {
  botPresenceReply,
  isBotPresenceQuestion,
  isPersonalFactQuestion,
  isPersonaSmalltalkQuestion,
  personaFactReply,
  personaSmalltalkReply,
} from "@/rag/persona-shortcuts.ts";

const human: Persona = { name: "Алина", role: "human", company: "Infinity" };
const assistant: Persona = { name: "Бот", role: "assistant" };

describe("isBotPresenceQuestion", () => {
  test("detects bare and 'ты <noun>' presence questions", () => {
    for (const q of ["бот?", "ты бот", "ты человек?", "ты chatgpt?", "are you a bot"]) {
      expect(isBotPresenceQuestion(q)).toBe(true);
    }
  });

  test("returns false for empty / job-intent questions", () => {
    expect(isBotPresenceQuestion("")).toBe(false);
    expect(isBotPresenceQuestion("есть работа в Китае?")).toBe(false);
    // job intent wins even when 'бот' is present
    expect(isBotPresenceQuestion("ты бот, а есть вакансии?")).toBe(false);
  });

  test("does not match 'бот' embedded in another word", () => {
    expect(isBotPresenceQuestion("заботливый")).toBe(false);
  });
});

describe("botPresenceReply", () => {
  test("human persona asserts being human and names the company", () => {
    const reply = botPresenceReply(human);
    expect(reply).toContain("живой человек");
    expect(reply).toContain("Алина");
    expect(reply).toContain("Infinity");
  });

  test("assistant persona admits being an AI helper", () => {
    expect(botPresenceReply(assistant)).toContain("ИИ-ассистент");
  });

  test("falls back to 'Менеджер' when name is blank", () => {
    expect(botPresenceReply({ name: "  ", role: "human" })).toContain("Менеджер");
  });
});

describe("isPersonaSmalltalkQuestion", () => {
  test("detects name / who-are-you smalltalk", () => {
    for (const q of [
      "как тебя зовут?",
      "имя?",
      "представься",
      "кто ты?",
      "what's your name",
      "who are you",
    ]) {
      expect(isPersonaSmalltalkQuestion(q)).toBe(true);
    }
  });

  test("returns false when job intent is also present", () => {
    expect(isPersonaSmalltalkQuestion("как тебя зовут, есть работа в Китае?")).toBe(false);
  });

  test("returns false for empty input", () => {
    expect(isPersonaSmalltalkQuestion("   ")).toBe(false);
  });
});

describe("isPersonalFactQuestion", () => {
  test("maps each attribute question to its fact key", () => {
    expect(isPersonalFactQuestion("где ты живёшь?")).toBe("city");
    expect(isPersonalFactQuestion("сколько тебе лет?")).toBe("age");
    expect(isPersonalFactQuestion("ты замужем?")).toBe("status");
    expect(isPersonalFactQuestion("дай номер")).toBe("phone");
  });

  test("returns null for job-intent or unrelated questions", () => {
    expect(isPersonalFactQuestion("в каком городе вакансия?")).toBeNull();
    expect(isPersonalFactQuestion("сколько платят?")).toBeNull();
    expect(isPersonalFactQuestion("")).toBeNull();
  });
});

describe("personaFactReply", () => {
  test("returns null when the fact is not configured", () => {
    expect(personaFactReply(human, "city")).toBeNull();
  });

  test("wraps a city value in a sentence (value inserted verbatim)", () => {
    const p: Persona = { ...human, facts: { city: "Сеул" } };
    expect(personaFactReply(p, "city")).toBe("Живу в Сеул.");
  });

  test("appends ' лет' to a numeric age, leaves a worded age as-is", () => {
    expect(personaFactReply({ ...human, facts: { age: "26" } }, "age")).toBe("26 лет.");
    expect(personaFactReply({ ...human, facts: { age: "26 лет" } }, "age")).toBe("26 лет.");
  });

  test("returns status / experience values verbatim", () => {
    const p: Persona = { ...human, facts: { status: "Не замужем, работа занимает всё время" } };
    expect(personaFactReply(p, "status")).toBe("Не замужем, работа занимает всё время");
  });
});

describe("personaSmalltalkReply", () => {
  test("human reply names the persona and the company", () => {
    const reply = personaSmalltalkReply(human);
    expect(reply).toContain("Алина");
    expect(reply).toContain("Infinity");
  });

  test("assistant reply identifies as a helper", () => {
    expect(personaSmalltalkReply(assistant)).toContain("Бот");
  });
});
