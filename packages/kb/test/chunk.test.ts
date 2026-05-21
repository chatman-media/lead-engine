import { describe, expect, test } from "bun:test";
import { chunkBySections, chunkText, estimateTokens } from "../src/chunk.ts";

describe("estimateTokens", () => {
  test("returns at least 1 for empty input", () => {
    expect(estimateTokens("")).toBe(1);
  });

  test("approximates ~4 chars per token", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("chunkText", () => {
  test("returns an empty array for blank input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  test("keeps short text as a single chunk", () => {
    const chunks = chunkText("Just a short text");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("Just a short text");
    expect(chunks[0]?.index).toBe(0);
  });

  test("splits long text into multiple bounded chunks", () => {
    const long = "word ".repeat(800).trim();
    const chunks = chunkText(long, { maxChars: 500, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(500);
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  test("throws when overlap is not smaller than maxChars", () => {
    expect(() => chunkText("abc", { maxChars: 50, overlapChars: 50 })).toThrow();
  });
});

describe("chunkBySections", () => {
  test("returns an empty array for blank input", () => {
    expect(chunkBySections("")).toEqual([]);
  });

  test("keeps a heading together with its body", () => {
    const chunks = chunkBySections("# Title\n\nBody text");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe("Title");
    expect(chunks[0]?.headingLevel).toBe(1);
    expect(chunks[0]?.text).toContain("# Title");
    expect(chunks[0]?.text).toContain("Body text");
  });

  test("splits a document into one chunk per heading", () => {
    const chunks = chunkBySections("# First\n\nAlpha body\n\n## Second\n\nBeta body");
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.heading)).toEqual(["First", "Second"]);
    expect(chunks.map((c) => c.headingLevel)).toEqual([1, 2]);
  });
});
