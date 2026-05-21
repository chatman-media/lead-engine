import { describe, expect, test } from "bun:test";
import { classifyTopic, classifyTopicAll, KNOWN_TOPICS } from "../src/topic-classifier.ts";

describe("classifyTopic", () => {
  test("returns a single topic when exactly one pattern matches", () => {
    expect(classifyTopic("Нужна ли виза?")).toBe("visa");
    expect(classifyTopic("Какой график работы?")).toBe("schedule");
  });

  test("returns null when multiple topics match (ambiguous)", () => {
    expect(classifyTopic("Какая зарплата и какой график?")).toBeNull();
  });

  test("returns null when no topic matches", () => {
    expect(classifyTopic("Привет, как дела?")).toBeNull();
  });

  test("returns null for blank input", () => {
    expect(classifyTopic("")).toBeNull();
    expect(classifyTopic("   ")).toBeNull();
  });
});

describe("classifyTopicAll", () => {
  test("returns every matching topic", () => {
    const matches = classifyTopicAll("Какая зарплата и какой график?");
    expect(matches).toContain("payment");
    expect(matches).toContain("schedule");
  });

  test("returns an empty array when nothing matches", () => {
    expect(classifyTopicAll("Привет, как дела?")).toEqual([]);
  });
});

describe("KNOWN_TOPICS", () => {
  test("exposes the defined topic slugs", () => {
    expect(KNOWN_TOPICS).toContain("visa");
    expect(KNOWN_TOPICS).toContain("payment");
    expect(KNOWN_TOPICS).toContain("schedule");
  });
});
