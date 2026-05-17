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

import type { ChatClient } from "@/rag/chat.ts";
import {
  judgePairwise,
  pairwiseToSoloOutcome,
  parsePairwiseVerdict,
  transcriptToString,
} from "@/sales/self-play/pairwise.ts";

type Transcript = Parameters<typeof transcriptToString>[0];

const TRANSCRIPT: Transcript = [
  { role: "candidate", text: "привет" },
  { role: "salesperson", text: "здравствуйте, расскажу про вакансию" },
];

/** ChatClient stub — returns a canned string or throws. */
const fakeChat = (reply: string | Error): ChatClient => ({
  complete: async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  },
});

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

describe("transcriptToString", () => {
  test("numbers each turn and labels the speaker", () => {
    expect(transcriptToString(TRANSCRIPT)).toBe(
      "[1] candidate: привет\n[2] salesperson: здравствуйте, расскажу про вакансию",
    );
  });

  test("returns an empty string for an empty transcript", () => {
    expect(transcriptToString([])).toBe("");
  });
});

describe("pairwiseToSoloOutcome", () => {
  test("maps winner to style-A's solo ELO outcome", () => {
    expect(pairwiseToSoloOutcome("a")).toBe("won");
    expect(pairwiseToSoloOutcome("b")).toBe("lost");
    expect(pairwiseToSoloOutcome("draw")).toBe("draw");
  });
});

describe("judgePairwise", () => {
  const baseArgs = {
    judgingHint: "anxious persona — reward a gentle tone",
    styleASlug: "alina-infinity",
    styleBSlug: "cold-direct-pas",
    transcriptA: TRANSCRIPT,
    transcriptB: TRANSCRIPT,
  };

  test("returns the parsed verdict from the judge LLM", async () => {
    const v = await judgePairwise({
      ...baseArgs,
      chat: fakeChat('{"winner":"b","reason":"B advanced to a call"}'),
    });
    expect(v.winner).toBe("b");
    expect(v.reason).toBe("B advanced to a call");
  });

  test("falls back to draw when the judge LLM throws", async () => {
    const v = await judgePairwise({
      ...baseArgs,
      chat: fakeChat(new Error("judge offline")),
    });
    expect(v.winner).toBe("draw");
    expect(v.reason).toContain("judge offline");
  });

  test("draws on unparseable judge output", async () => {
    const v = await judgePairwise({ ...baseArgs, chat: fakeChat("no json here") });
    expect(v.winner).toBe("draw");
  });
});
