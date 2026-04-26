import { describe, expect, test } from "bun:test";

import { chunkText } from "@/rag/chunk.ts";

describe("chunkText", () => {
  test("returns one chunk for short input", () => {
    const out = chunkText("hello world", { maxChars: 100, overlapChars: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("hello world");
    expect(out[0]!.index).toBe(0);
    expect(out[0]!.tokenCount).toBeGreaterThan(0);
  });

  test("splits long input into multiple chunks under maxChars", () => {
    const para = "a".repeat(500);
    const out = chunkText(para, { maxChars: 200, overlapChars: 20 });
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(200);
    }
    expect(out.map((c) => c.index)).toEqual(out.map((_, i) => i));
  });

  test("prefers paragraph boundaries when possible", () => {
    const text = ["para one with words", "para two with words"].join("\n\n");
    const out = chunkText(text, { maxChars: 30, overlapChars: 0 });
    expect(out.length).toBe(2);
    expect(out[0]!.text).toContain("para one");
    expect(out[1]!.text).toContain("para two");
  });

  test("ignores empty input", () => {
    expect(chunkText("", { maxChars: 100, overlapChars: 10 })).toEqual([]);
    expect(chunkText("   \n\n   ", { maxChars: 100, overlapChars: 10 })).toEqual(
      [],
    );
  });

  test("overlap copies tail of previous chunk into next", () => {
    const text = "x".repeat(300);
    const out = chunkText(text, { maxChars: 100, overlapChars: 20 });
    expect(out.length).toBeGreaterThanOrEqual(2);
    const tailOf0 = out[0]!.text.slice(-20);
    expect(out[1]!.text.startsWith(tailOf0)).toBe(true);
  });
});
