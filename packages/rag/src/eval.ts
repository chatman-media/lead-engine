import type { KbSearchHit } from "./types.ts";

/**
 * One labelled query for retrieval evaluation.
 * `relevantChunkIds` are the ground-truth chunk ids that should be retrieved.
 */
export interface EvalQuery {
  question: string;
  relevantChunkIds: number[];
}

/** Per-query metrics returned by `evalRetrieval`. */
export interface QueryMetrics {
  question: string;
  /** Fraction of relevant chunks found in the top-k results (0–1). */
  recallAtK: number;
  /** Mean Reciprocal Rank — position of the first relevant hit (0–1). */
  mrr: number;
  /** Normalised Discounted Cumulative Gain (0–1). */
  ndcg: number;
  /** Chunk ids that were retrieved. */
  retrievedIds: number[];
}

/** Aggregated metrics over a full eval set. */
export interface EvalResult {
  /** Arithmetic mean of recall@k across all queries. */
  meanRecallAtK: number;
  /** Arithmetic mean of MRR across all queries. */
  meanMrr: number;
  /** Arithmetic mean of NDCG across all queries. */
  meanNdcg: number;
  /** Per-query breakdown. */
  queries: QueryMetrics[];
}

/**
 * Evaluate retrieval quality over a labelled query set.
 *
 * Runs `retrieve(query)` for each `EvalQuery`, compares the returned chunk ids
 * against the ground-truth relevant ids, and reports recall@k, MRR, and NDCG.
 *
 * @param queries     Labelled queries with ground-truth chunk ids.
 * @param retrieve    Function that takes a question and returns `KbSearchHit[]`.
 *                    Wrap your `kb.search()` / `kb.hybridSearch()` call here.
 *
 * @example
 * ```ts
 * import { evalRetrieval } from "@chatman-media/rag";
 *
 * const result = await evalRetrieval(
 *   [
 *     { question: "Какая зарплата в Дубае?", relevantChunkIds: [12, 15] },
 *     { question: "Нужна ли виза?",          relevantChunkIds: [7] },
 *   ],
 *   async (q) => {
 *     const [vec] = await embedder.embed([q]);
 *     return kb.hybridSearch({ embedding: vec!, query: q, k: 5 });
 *   },
 * );
 *
 * console.log(`recall@5: ${result.meanRecallAtK.toFixed(3)}`);
 * console.log(`MRR:      ${result.meanMrr.toFixed(3)}`);
 * console.log(`NDCG:     ${result.meanNdcg.toFixed(3)}`);
 * ```
 */
export async function evalRetrieval(
  queries: EvalQuery[],
  retrieve: (question: string) => Promise<KbSearchHit[]>,
): Promise<EvalResult> {
  const queryMetrics: QueryMetrics[] = [];

  for (const q of queries) {
    const hits = await retrieve(q.question);
    const retrievedIds = hits.map((h) => h.chunk_id);
    const relevant = new Set(q.relevantChunkIds);

    queryMetrics.push({
      question: q.question,
      recallAtK: recallAtK(retrievedIds, relevant),
      mrr: mrr(retrievedIds, relevant),
      ndcg: ndcg(retrievedIds, relevant),
      retrievedIds,
    });
  }

  const mean = (arr: number[]) =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    meanRecallAtK: mean(queryMetrics.map((q) => q.recallAtK)),
    meanMrr: mean(queryMetrics.map((q) => q.mrr)),
    meanNdcg: mean(queryMetrics.map((q) => q.ndcg)),
    queries: queryMetrics,
  };
}

// ── Metric implementations ────────────────────────────────────────────────────

function recallAtK(retrieved: number[], relevant: Set<number>): number {
  if (relevant.size === 0) return 1;
  const found = retrieved.filter((id) => relevant.has(id)).length;
  return found / relevant.size;
}

function mrr(retrieved: number[], relevant: Set<number>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i] as number)) return 1 / (i + 1);
  }
  return 0;
}

function ndcg(retrieved: number[], relevant: Set<number>): number {
  const dcg = retrieved.reduce((sum, id, i) => {
    const gain = relevant.has(id) ? 1 : 0;
    return sum + gain / Math.log2(i + 2);
  }, 0);

  // Ideal DCG: all relevant docs at the top
  const idealLen = Math.min(relevant.size, retrieved.length);
  const idcg = Array.from({ length: idealLen }, (_, i) => 1 / Math.log2(i + 2)).reduce(
    (a, b) => a + b,
    0,
  );

  return idcg === 0 ? 0 : dcg / idcg;
}
