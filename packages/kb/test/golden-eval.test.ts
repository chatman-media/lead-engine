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

  test("compare treats an unknown variant as a zero baseline", async () => {
    const current = await evaluateRagGoldenCases({
      cases: [{ id: "case", question: "Need pricing policy", expectedFacts: ["operator review"] }],
      makeInput: (item) => makeInput(item),
    });
    const deltas = compareRagGoldenReports(current, { ...current, variants: [] });
    expect(deltas[0]?.passRateDelta).toBe(1);
    expect(deltas[0]?.retrievalRecallDelta).toBe(1);
    expect(deltas[0]?.personaConsistencyDelta).toBe(1);
  });

  test("every default ablation mutates the answer input", async () => {
    const reranker = { rerank: async (_q: string, hits: KbSearchHit[]) => hits };
    const base = {
      ...makeInput({ id: "x", question: "q" }),
      rewriteQueryBeforeRetrieval: true,
      multiQuery: true,
      topicRouting: true,
      mmr: true,
      reflect: true,
      reranker,
    };
    const byId = new Map(defaultRagGoldenAblations().map((item) => [item.id, item]));
    expect([...byId.keys()].sort()).toEqual([
      "no_hybrid",
      "no_mmr",
      "no_multi_query",
      "no_reflect",
      "no_reranker",
      "no_rewrite",
      "no_topic_routing",
    ]);
    const item: RagGoldenCase = { id: "x", question: "q" };
    const mutate = async (id: string) => byId.get(id)?.mutateInput(base, item);
    expect((await mutate("no_rewrite"))?.rewriteQueryBeforeRetrieval).toBe(false);
    expect((await mutate("no_multi_query"))?.multiQuery).toBe(false);
    expect((await mutate("no_hybrid"))?.hybridSearch).toBe(false);
    expect((await mutate("no_topic_routing"))?.topicRouting).toBe(false);
    expect((await mutate("no_mmr"))?.mmr).toBe(false);
    expect((await mutate("no_reflect"))?.reflect).toBe(false);
    const noReranker = await mutate("no_reranker");
    expect(noReranker && "reranker" in noReranker).toBe(false);
  });

  test("judge result parsing returns {} on missing or broken JSON", () => {
    expect(parseRagGoldenJudgeResult("no json here")).toEqual({});
    // braces present but invalid JSON inside → JSON.parse throws → {}
    expect(parseRagGoldenJudgeResult("{broken: json,}")).toEqual({});
  });

  test("judge result parsing survives an unclosed <think> block", () => {
    // text BEFORE the unclosed think tag is kept, the tail is dropped
    const parsed = parseRagGoldenJudgeResult('{"groundedness":0.5}<think>still reasoning');
    expect(parsed).toEqual({ groundedness: 0.5 });
    // nothing before the unclosed tag → no JSON at all
    expect(parseRagGoldenJudgeResult("<think>only reasoning")).toEqual({});
    // input that ENDS with a closed think block (loop drains to empty rest)
    expect(parseRagGoldenJudgeResult('{"groundedness":0.5}<think>tail</think>')).toEqual({
      groundedness: 0.5,
    });
  });

  test("answerWithRag throw → failed case with zeroed metrics", async () => {
    const report = await evaluateRagGoldenCases({
      cases: [
        { id: "boom", question: "Need pricing policy" },
        { id: "boom-string", question: "Need pricing policy" },
      ],
      makeInput: (item) => ({
        ...makeInput(item),
        chat: {
          complete: async () => {
            if (item.id === "boom-string") throw "string failure";
            throw new Error("llm down");
          },
        },
      }),
    });

    expect(report.results).toHaveLength(2);
    for (const result of report.results) expect(result.passed).toBe(false);
    expect(report.results[0]?.metrics).toEqual({
      retrievalRecall: 0,
      groundedness: 0,
      personaConsistency: 0,
      forbiddenViolations: 0,
    });
    expect(report.results[0]?.failures[0]?.expected).toBe("answerWithRag completes");
    expect(report.results[0]?.failures[0]?.actual).toBe("llm down");
    expect(report.results[1]?.failures[0]?.actual).toBe("string failure");
    expect(report.results[0]?.telemetry.path).toBe("no_context");
  });

  test("persona, answerIncludes and expectedPath failures are reported with details", async () => {
    const longAnswer = `Prices are confirmed after operator review. ${"filler ".repeat(40)}end`;
    const report = await evaluateRagGoldenCases({
      cases: [
        {
          id: "persona-path",
          question: "Need pricing policy",
          personaExpectations: ["plain language"],
          answerIncludes: ["money-back guarantee"],
          expectedPath: "smalltalk",
        },
      ],
      makeInput: (item) => makeInput(item, { answer: longAnswer }),
    });

    const formatted = formatRagGoldenFailures(report);
    expect(report.results[0]?.passed).toBe(false);
    expect(formatted).toContain("personaConsistency");
    expect(formatted).toContain("missing persona expectations: plain language");
    expect(formatted).toContain('answer includes "money-back guarantee"');
    // the long answer is summarized to 160 chars with an ellipsis
    expect(formatted).toContain("...");
    expect(formatted).toContain("telemetry.path=smalltalk");
  });
});
