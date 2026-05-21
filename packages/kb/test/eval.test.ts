import { describe, expect, test } from "bun:test";
import { type EvalQuery, evalRetrieval } from "../src/eval.ts";
import type { KbSearchHit } from "../src/types.ts";

function hit(id: number): KbSearchHit {
  return { chunk_id: id, distance: 0, text: "", document_id: 1, source: "", title: "" };
}

function retrieverFrom(map: Record<string, number[]>) {
  return async (question: string): Promise<KbSearchHit[]> => (map[question] ?? []).map(hit);
}

describe("evalRetrieval", () => {
  test("scores perfect retrieval as 1 across all metrics", async () => {
    const queries: EvalQuery[] = [{ question: "q", relevantChunkIds: [1, 2] }];
    const result = await evalRetrieval(queries, retrieverFrom({ q: [1, 2] }));
    expect(result.meanRecallAtK).toBeCloseTo(1);
    expect(result.meanMrr).toBeCloseTo(1);
    expect(result.meanNdcg).toBeCloseTo(1);
  });

  test("MRR reflects the rank of the first relevant hit", async () => {
    const queries: EvalQuery[] = [{ question: "q", relevantChunkIds: [3] }];
    const result = await evalRetrieval(queries, retrieverFrom({ q: [1, 2, 3] }));
    expect(result.meanMrr).toBeCloseTo(1 / 3);
    expect(result.meanRecallAtK).toBeCloseTo(1);
  });

  test("scores a complete miss as 0", async () => {
    const queries: EvalQuery[] = [{ question: "q", relevantChunkIds: [9] }];
    const result = await evalRetrieval(queries, retrieverFrom({ q: [1, 2] }));
    expect(result.meanRecallAtK).toBe(0);
    expect(result.meanMrr).toBe(0);
    expect(result.meanNdcg).toBe(0);
  });

  test("recall counts the fraction of relevant chunks found", async () => {
    const queries: EvalQuery[] = [{ question: "q", relevantChunkIds: [1, 2, 3, 4] }];
    const result = await evalRetrieval(queries, retrieverFrom({ q: [1, 2] }));
    expect(result.meanRecallAtK).toBeCloseTo(0.5);
  });

  test("aggregates means across multiple queries", async () => {
    const queries: EvalQuery[] = [
      { question: "hit", relevantChunkIds: [1] },
      { question: "miss", relevantChunkIds: [9] },
    ];
    const result = await evalRetrieval(queries, retrieverFrom({ hit: [1], miss: [2] }));
    expect(result.meanRecallAtK).toBeCloseTo(0.5);
    expect(result.queries).toHaveLength(2);
  });
});
