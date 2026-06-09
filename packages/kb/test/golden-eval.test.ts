import { describe, expect, test } from "bun:test";
import type { ChatClient, ChatMessage, EmbeddingClient } from "@chatman-media/llm-router";
import {
  compareRagGoldenReports,
  defaultRagGoldenAblations,
  evaluateRagGoldenCases,
  formatRagGoldenFailures,
  makeRagGoldenLlmJudge,
  parseRagGoldenJsonl,
  parseRagGoldenJudgeResult,
  type RagGoldenCase,
} from "../src/golden-eval.ts";
import type { IKbStore, KbSearchHit } from "../src/types.ts";

const embedder: EmbeddingClient = {
  dim: 3,
  embed: async (inputs) => inputs.map(() => [1, 0, 0]),
};

function hit(id: number, over: Partial<KbSearchHit> = {}): KbSearchHit {
  return {
    chunk_id: id,
    distance: 0.1,
    text: `chunk ${id}`,
    document_id: 1,
    source: `fixture:${id}`,
    title: `Fixture ${id}`,
    ...over,
  };
}

function fakeChat(reply: string): ChatClient {
  return {
    complete: async (messages: ChatMessage[]) => {
      const system = messages[0]?.content ?? "";
      if (system.includes("альтернативные формулировки")) {
        return "policy rules\noperator review";
      }
      return reply;
    },
  };
}

function fakeKb(input: { search?: KbSearchHit[]; hybrid?: KbSearchHit[] }): IKbStore {
  const searchHits = input.search ?? [];
  const hybridHits = input.hybrid ?? searchHits;
  return {
    search: async () => searchHits,
    hybridSearch: async () => hybridHits,
    prioritySearch: async () => hybridHits,
    getDocumentBySource: async () => null,
    countChunksForDocument: async () => 0,
    deleteDocument: async () => false,
    upsertDocument: async () => ({ id: 1 }),
    insertChunkWithEmbedding: async () => {},
  };
}

function makeInput(item: RagGoldenCase, over: Partial<{ answer: string; kb: IKbStore }> = {}) {
  return {
    question: item.question,
    kb:
      over.kb ??
      fakeKb({
        search: [
          hit(7, {
            title: "Pricing policy",
            source: "kb://pricing",
            text: "Prices are confirmed after operator review.",
          }),
        ],
      }),
    embedder,
    chat: fakeChat(over.answer ?? "Prices are confirmed after operator review in plain language."),
    topK: 3,
    hybridSearch: true,
  };
}

describe("RAG golden eval", () => {
  test("parses JSONL cases and ignores comments", () => {
    const cases = parseRagGoldenJsonl(`
# comment
{"id":"one","question":"q1"}

{"id":"two","question":"q2"}
`);
    expect(cases.map((item) => item.id)).toEqual(["one", "two"]);
  });

  test("passes when retrieval, answer facts, and persona expectations match", async () => {
    const report = await evaluateRagGoldenCases({
      cases: [
        {
          id: "pricing",
          question: "Need pricing policy",
          expectedSources: ["Pricing policy"],
          expectedFacts: ["operator review"],
          personaExpectations: ["plain language"],
          forbiddenFacts: ["guaranteed discount"],
          answerIncludes: ["operator review"],
          expectedPath: "ok",
        },
      ],
      makeInput: (item) => makeInput(item),
    });

    expect(report.variants).toHaveLength(1);
    expect(report.variants[0]?.passed).toBe(1);
    expect(report.results[0]?.passed).toBe(true);
    expect(formatRagGoldenFailures(report)).toBe("");
  });

  test("formats missing source, missing fact, and forbidden text failures", async () => {
    const report = await evaluateRagGoldenCases({
      cases: [
        {
          id: "bad-answer",
          question: "Need pricing policy",
          expectedSources: ["Missing source"],
          expectedFacts: ["operator review"],
          answerExcludes: ["guaranteed discount"],
        },
      ],
      makeInput: (item) =>
        makeInput(item, {
          answer: "We can offer a guaranteed discount.",
        }),
    });

    expect(report.results[0]?.passed).toBe(false);
    const formatted = formatRagGoldenFailures(report);
    expect(formatted).toContain("case=bad-answer");
    expect(formatted).toContain("retrievalRecall");
    expect(formatted).toContain("groundedness");
    expect(formatted).toContain("forbiddenViolations");
  });

  test("runs ablations as separate variants", async () => {
    const ablations = defaultRagGoldenAblations().filter((item) => item.id === "no_hybrid");
    const report = await evaluateRagGoldenCases({
      cases: [
        {
          id: "hybrid-only-source",
          question: "Need pricing policy",
          expectedSources: ["Hybrid policy"],
          expectedFacts: ["operator review"],
        },
      ],
      makeInput: (item) =>
        makeInput(item, {
          kb: fakeKb({
            search: [hit(1, { title: "Vector policy" })],
            hybrid: [hit(2, { title: "Hybrid policy" })],
          }),
        }),
      ablations,
    });

    expect(report.variants.map((variant) => variant.variantId)).toEqual(["baseline", "no_hybrid"]);
    expect(report.variants.find((variant) => variant.variantId === "baseline")?.failed).toBe(0);
    expect(report.variants.find((variant) => variant.variantId === "no_hybrid")?.failed).toBe(1);
  });

  test("allows a judge to override semantic answer metrics", async () => {
    const report = await evaluateRagGoldenCases({
      cases: [
        {
          id: "semantic-grounding",
          question: "Need pricing policy",
          expectedSources: ["Pricing policy"],
          expectedFacts: ["operator review"],
        },
      ],
      makeInput: (item) =>
        makeInput(item, {
          answer: "A human teammate confirms the final price before we quote it.",
        }),
      judge: async () => ({
        groundedness: 1,
        notes: ["semantic match for operator review"],
      }),
    });

    expect(report.results[0]?.passed).toBe(true);
    expect(report.results[0]?.judgeNotes).toEqual(["semantic match for operator review"]);
  });

  test("parses LLM judge JSON with clamped metrics", () => {
    const parsed = parseRagGoldenJudgeResult(
      '<think>reasoning</think>```json\n{"groundedness":1.4,"personaConsistency":-1,"forbiddenViolations":2.9,"notes":["ok",7]}\n```',
    );
    expect(parsed).toEqual({
      groundedness: 1,
      personaConsistency: 0,
      forbiddenViolations: 2,
      notes: ["ok"],
    });
  });

  test("makeRagGoldenLlmJudge asks chat for JSON metrics", async () => {
    const judge = makeRagGoldenLlmJudge({
      chat: fakeChat('{"groundedness":0.75,"personaConsistency":1,"forbiddenViolations":0}'),
    });
    const result = await judge({
      item: { id: "judge", question: "Need pricing policy", expectedFacts: ["operator review"] },
      variantId: "baseline",
      deterministicMetrics: {
        retrievalRecall: 1,
        groundedness: 0,
        personaConsistency: 1,
        forbiddenViolations: 0,
      },
      answer: {
        text: "A human teammate confirms the final price.",
        usedChunkIds: [7],
        hits: [
          hit(7, {
            title: "Pricing policy",
            source: "kb://pricing",
            text: "Prices are confirmed after operator review.",
          }),
        ],
        telemetry: { path: "ok" },
      },
    });

    expect(result.groundedness).toBe(0.75);
    expect(result.personaConsistency).toBe(1);
    expect(result.forbiddenViolations).toBe(0);
  });

  test("compares current report against a baseline report", async () => {
    const current = await evaluateRagGoldenCases({
      cases: [{ id: "case", question: "Need pricing policy", expectedFacts: ["operator review"] }],
      makeInput: (item) => makeInput(item),
    });
    const baseline = {
      ...current,
      variants: current.variants.map((variant) => ({
        ...variant,
        passRate: 0,
        meanGroundedness: 0,
      })),
    };

    const deltas = compareRagGoldenReports(current, baseline);
    expect(deltas[0]?.passRateDelta).toBe(1);
    expect(deltas[0]?.groundednessDelta).toBe(1);
  });
});
