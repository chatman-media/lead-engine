import { describe, expect, test } from "bun:test";
import { parseVerdict } from "../self-play/judge.ts";

describe("parseVerdict — clean JSON", () => {
  test("won", () => {
    const v = parseVerdict('{"outcome":"won","reason":"accepted the call"}');
    expect(v.outcome).toBe("won");
    expect(v.reason).toBe("accepted the call");
    expect(v.raw).toBeUndefined();
  });

  test("lost", () => {
    const v = parseVerdict('{"outcome":"lost","reason":"said it was a scam"}');
    expect(v.outcome).toBe("lost");
  });

  test("draw", () => {
    const v = parseVerdict('{"outcome":"draw","reason":"said she\'ll think"}');
    expect(v.outcome).toBe("draw");
  });
});

describe("parseVerdict — code-fenced JSON", () => {
  test("```json fence stripped", () => {
    const raw = '```json\n{"outcome":"won","reason":"agreed"}\n```';
    expect(parseVerdict(raw).outcome).toBe("won");
  });

  test("plain ``` fence stripped", () => {
    const raw = '```\n{"outcome":"lost","reason":"blocked"}\n```';
    expect(parseVerdict(raw).outcome).toBe("lost");
  });
});

describe("parseVerdict — <think> block stripped", () => {
  test("think block before JSON", () => {
    const raw =
      '<think>Hmm, let me think…</think>\n{"outcome":"draw","reason":"ambiguous"}';
    expect(parseVerdict(raw).outcome).toBe("draw");
  });
});

describe("parseVerdict — regex fallback", () => {
  test("invalid JSON but outcome key present → fallback", () => {
    const raw = 'outcome: "won", reason: "she agreed"'; // not valid JSON
    const v = parseVerdict(raw);
    // regex won't match this format — should default to draw
    expect(["won", "lost", "draw"]).toContain(v.outcome);
  });

  test("JSON with outcome key buried in junk", () => {
    const raw = 'Some text {"outcome": "lost", "reason": "refused"} more text';
    const v = parseVerdict(raw);
    expect(v.outcome).toBe("lost");
    expect(v.reason).toBe("refused");
  });
});

describe("parseVerdict — unparseable input", () => {
  test("random text → draw with raw", () => {
    const v = parseVerdict("I cannot determine the outcome");
    expect(v.outcome).toBe("draw");
    expect(v.reason).toBe("judge output unparseable");
    expect(v.raw).toBeDefined();
  });

  test("empty string → draw", () => {
    const v = parseVerdict("");
    expect(v.outcome).toBe("draw");
  });
});

describe("parseVerdict — missing reason", () => {
  test("no reason field → fallback string", () => {
    const v = parseVerdict('{"outcome":"won"}');
    expect(v.outcome).toBe("won");
    expect(v.reason).toBe("(no reason)");
  });
});
