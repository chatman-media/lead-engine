/**
 * Pairwise self-play tests.
 *
 * `parsePairwiseVerdict` is the only LLM-output-handling logic worth
 * isolating — the rest of `runPairwiseMatch` just delegates to
 * `runSelfPlayMatch` (already covered) and `judgePairwise` (an LLM call).
 * For pairwise judge integration we test `parsePairwiseVerdict` against
 * realistic model outputs: bare JSON, code-fenced JSON, garbage.
 */
import { describe, expect, test } from "bun:test";

import { parsePairwiseVerdict } from "@/sales/self-play/pairwise.ts";

describe("parsePairwiseVerdict", () => {
  test("parses bare JSON object", () => {
    const v = parsePairwiseVerdict('{"winner":"a","reason":"A closed with anketa"}');
    expect(v.winner).toBe("a");
    expect(v.reason).toBe("A closed with anketa");
  });

  test("parses code-fenced JSON", () => {
    const raw = '```json\n{"winner":"b","reason":"B handled the fear better"}\n```';
    const v = parsePairwiseVerdict(raw);
    expect(v.winner).toBe("b");
    expect(v.reason).toContain("fear");
  });

  test("parses draw verdict", () => {
    const v = parsePairwiseVerdict('{"winner":"draw","reason":"both stalled at qualify"}');
    expect(v.winner).toBe("draw");
  });

  test("falls back to regex when JSON is malformed but key/value visible", () => {
    const raw = 'I think "winner": "a", "reason": "clear close" — final answer.';
    const v = parsePairwiseVerdict(raw);
    expect(v.winner).toBe("a");
    expect(v.reason).toBe("clear close");
  });

  test("defaults to draw + raw on completely unparseable output", () => {
    const v = parsePairwiseVerdict("the salesperson A is the winner here, no doubt");
    expect(v.winner).toBe("draw");
    expect(v.reason).toContain("unparseable");
    expect(v.raw).toContain("salesperson A");
  });

  test("rejects unknown winner values", () => {
    const v = parsePairwiseVerdict('{"winner":"both","reason":"tied"}');
    expect(v.winner).toBe("draw");
  });

  test("handles missing reason gracefully", () => {
    const v = parsePairwiseVerdict('{"winner":"a"}');
    expect(v.winner).toBe("a");
    expect(v.reason).toBe("(no reason)");
  });
});
