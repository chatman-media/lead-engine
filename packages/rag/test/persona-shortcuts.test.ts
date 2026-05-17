import { describe, expect, test } from "bun:test";
import type { Persona } from "../src/answer-types.ts";
import {
  botPresenceReply,
  isBotPresenceQuestion,
  isPersonalFactQuestion,
  isPersonaSmalltalkQuestion,
  personaFactReply,
  personaSmalltalkReply,
} from "../src/persona-shortcuts.ts";

const human: Persona = { name: "Анна", role: "human", company: "Acme" };
const assistant: Persona = { name: "Бот", role: "assistant" };

describe("isBotPresenceQuestion", () => {
  test("detects bot/human/AI presence questions", () => {
    expect(isBotPresenceQuestion("ты бот?")).toBe(true);
    expect(isBotPresenceQuestion("ты человек?")).toBe(true);
    expect(isBotPresenceQuestion("are you a bot")).toBe(true);
  });

  test("ignores questions carrying job intent", () => {
    expect(isBotPresenceQuestion("есть работа в китае?")).toBe(false);
  });

  test("returns false for blank input", () => {
    expect(isBotPresenceQuestion("")).toBe(false);
  });
});

describe("botPresenceReply", () => {
  test("asserts being human for a human persona", () => {
    const reply = botPresenceReply(human);
    expect(reply).toContain("живой человек");
    expect(reply).toContain("Анна");
  });

  test("admits being an AI for an assistant persona", () => {
    expect(botPresenceReply(assistant)).toContain("ИИ-ассистент");
  });
});

describe("isPersonaSmalltalkQuestion", () => {
  test("detects identity smalltalk", () => {
    expect(isPersonaSmalltalkQuestion("как тебя зовут?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("кто ты?")).toBe(true);
    expect(isPersonaSmalltalkQuestion("what's your name?")).toBe(true);
  });

  test("ignores smalltalk mixed with job intent", () => {
    expect(isPersonaSmalltalkQuestion("как тебя зовут, есть работа?")).toBe(false);
  });
});

describe("isPersonalFactQuestion", () => {
  test("maps questions to the personal-fact key", () => {
    expect(isPersonalFactQuestion("где ты живёшь?")).toBe("city");
    expect(isPersonalFactQuestion("сколько тебе лет?")).toBe("age");
    expect(isPersonalFactQuestion("ты замужем?")).toBe("status");
    expect(isPersonalFactQuestion("дай свой номер телефона")).toBe("phone");
  });

  test("returns null when the question carries job intent", () => {
    expect(isPersonalFactQuestion("какая зарплата?")).toBeNull();
  });
});

describe("personaFactReply", () => {
  const persona: Persona = { name: "Анна", role: "human", facts: { city: "Москва", age: "26" } };

  test("wraps city and age values in natural templates", () => {
    expect(personaFactReply(persona, "city")).toContain("Москва");
    expect(personaFactReply(persona, "age")).toBe("26 лет.");
  });

  test("returns null when the fact is not configured", () => {
    expect(personaFactReply(persona, "status")).toBeNull();
  });
});

describe("personaSmalltalkReply", () => {
  test("introduces a human persona by name", () => {
    expect(personaSmalltalkReply(human).startsWith("Меня зовут Анна")).toBe(true);
  });

  test("introduces an assistant persona by name", () => {
    expect(personaSmalltalkReply(assistant)).toBe("Я Бот.");
  });
});
