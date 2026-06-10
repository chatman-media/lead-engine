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

  test("merges short paragraphs into one chunk and starts a new one when full", () => {
    const text = "aaaa\n\nbbbb\n\ncccccccccccccccc";
    const chunks = chunkText(text, { maxChars: 20, overlapChars: 0 });
    // aaaa+bbbb fit together (4+2+4=10 ≤ 20); the long c-paragraph starts a new chunk
    expect(chunks.map((c) => c.text)).toEqual(["aaaa\n\nbbbb", "cccccccccccccccc"]);
  });

  test("flushes the pending buffer before an oversized paragraph", () => {
    const text = `intro paragraph\n\n${"x".repeat(60)}`;
    const chunks = chunkText(text, { maxChars: 30, overlapChars: 0 });
    expect(chunks[0]?.text).toBe("intro paragraph");
    // the oversized paragraph was hard-split into ≤30-char slices
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks.slice(1)) expect(c.text).toMatch(/^x+$/);
  });

  test("prepends the previous tail as overlap without exceeding maxChars", () => {
    const text = `${"a".repeat(18)}\n\n${"b".repeat(18)}`;
    const chunks = chunkText(text, { maxChars: 20, overlapChars: 4 });
    expect(chunks).toHaveLength(2);
    // second chunk starts with the 4-char tail of the first
    expect(chunks[1]?.text.startsWith("aaaa")).toBe(true);
    expect(chunks[1]?.text.length).toBeLessThanOrEqual(20);
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

  test("falls back to chunkText for an oversized section, keeping the heading context", () => {
    const body = "word ".repeat(60).trim();
    const chunks = chunkBySections(`# Big\n\n${body}\n\n## Small\n\ntiny`, {
      maxChars: 100,
      overlapChars: 10,
    });
    const big = chunks.filter((c) => c.heading === "Big");
    expect(big.length).toBeGreaterThan(1);
    for (const c of big) {
      expect(c.headingLevel).toBe(1);
      expect(c.text.length).toBeLessThanOrEqual(100);
    }
    // sub-chunks keep a continuous global index, the next section continues it
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks[chunks.length - 1]?.heading).toBe("Small");
  });

  test("keeps a heading-only section and document preamble", () => {
    const chunks = chunkBySections("preamble text\n\n# Lonely heading");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.heading).toBeNull();
    expect(chunks[0]?.text).toBe("preamble text");
    expect(chunks[1]?.heading).toBe("Lonely heading");
  });
});
