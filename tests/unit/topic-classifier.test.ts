import { describe, expect, test } from "bun:test";

import {
  classifyTopic,
  classifyTopicAll,
  KNOWN_TOPICS,
} from "@/rag/topic-classifier.ts";

describe("classifyTopic", () => {
  test("returns null on empty/whitespace", () => {
    expect(classifyTopic("")).toBeNull();
    expect(classifyTopic("   ")).toBeNull();
  });

  test("classifies visa-related questions", () => {
    expect(classifyTopic("какая виза нужна?")).toBe("visa");
    expect(classifyTopic("оформление визы")).toBe("visa");
    expect(classifyTopic("invitation letter?")).toBe("visa");
  });

  test("classifies payment-related questions", () => {
    expect(classifyTopic("сколько платят?")).toBe("payment");
    expect(classifyTopic("какая зарплата?")).toBe("payment");
    expect(classifyTopic("оплата в юанях?")).toBe("payment");
    expect(classifyTopic("rate per day?")).toBe("payment");
  });

  test("classifies schedule-related questions", () => {
    expect(classifyTopic("какой график работы?")).toBe("schedule");
    expect(classifyTopic("сколько смен в неделю?")).toBe("schedule");
  });

  test("classifies housing-related questions", () => {
    expect(classifyTopic("где жить?")).toBe("housing");
    expect(classifyTopic("какое проживание?")).toBe("housing");
    expect(classifyTopic("общежитие или квартира?")).toBe("housing");
  });

  test("classifies location-related questions", () => {
    expect(classifyTopic("работа в Дубае?")).toBe("locations");
    expect(classifyTopic("в Стамбул когда?")).toBe("locations");
    expect(classifyTopic("Корея условия?")).toBe("locations");
  });

  test("classifies vacancy-related questions", () => {
    expect(classifyTopic("какие у вас вакансии?")).toBe("vacancy");
    expect(classifyTopic("что у вас сейчас?")).toBe("vacancy");
    expect(classifyTopic("есть KTV?")).toBe("vacancy");
    expect(classifyTopic("ищу хостес")).toBe("vacancy");
  });

  test("classifies requirements-related questions", () => {
    expect(classifyTopic("какой нужен рост?")).toBe("requirements");
    expect(classifyTopic("во сколько лет можно?")).toBe("requirements");
    expect(classifyTopic("нужно ли портфолио?")).toBe("requirements");
    expect(classifyTopic("какие требования?")).toBe("requirements");
  });

  test("classifies application-related questions", () => {
    expect(classifyTopic("где анкета?")).toBe("application");
    expect(classifyTopic("как подать заявку?")).toBe("application");
  });

  test("returns null on ambiguous (multi-topic) questions", () => {
    // "виза в Дубае" matches both visa AND locations → ambiguous → null
    expect(classifyTopic("какая виза нужна для Дубая?")).toBeNull();
    // "сколько платят и где жить?" matches payment AND housing → null
    expect(classifyTopic("сколько платят и где жить?")).toBeNull();
  });

  test("returns null on questions outside the topic catalog", () => {
    expect(classifyTopic("привет, как дела?")).toBeNull();
    expect(classifyTopic("что нового?")).toBeNull();
    expect(classifyTopic("ты бот?")).toBeNull();
  });

  test("does not match partial words (Cyrillic word boundaries work)", () => {
    // "девиз" contains "виз" but should not be classified as visa
    expect(classifyTopic("какой у тебя девиз?")).toBeNull();
  });
});

describe("classifyTopicAll", () => {
  test("returns all matching topics for ambiguous questions", () => {
    const matches = classifyTopicAll("какая виза нужна для Дубая?");
    expect(matches).toContain("visa");
    expect(matches).toContain("locations");
    expect(matches.length).toBe(2);
  });

  test("returns empty array on no matches", () => {
    expect(classifyTopicAll("привет")).toEqual([]);
  });
});

describe("KNOWN_TOPICS", () => {
  test("includes all expected topics", () => {
    expect(KNOWN_TOPICS).toContain("visa");
    expect(KNOWN_TOPICS).toContain("payment");
    expect(KNOWN_TOPICS).toContain("schedule");
    expect(KNOWN_TOPICS).toContain("housing");
    expect(KNOWN_TOPICS).toContain("locations");
    expect(KNOWN_TOPICS).toContain("application");
    expect(KNOWN_TOPICS).toContain("vacancy");
    expect(KNOWN_TOPICS).toContain("requirements");
  });
});
