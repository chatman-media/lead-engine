import { describe, expect, it } from "bun:test";
import { EmbeddingApiError, type FetchLike } from "../types.ts";
import { OpenAIEmbeddingClient } from "./openai-embed.ts";

/** Stub fetch, возвращающий заданный вектор для единственного input'а. */
function stubFetch(embedding: number[]): FetchLike {
  return (async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as FetchLike;
}

function makeClient(dim: number, embedding: number[]): OpenAIEmbeddingClient {
  return new OpenAIEmbeddingClient({
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    model: "test-embed",
    dim,
    fetch: stubFetch(embedding),
  });
}

describe("OpenAIEmbeddingClient.fitDim", () => {
  it("точное совпадение размерности → вектор без изменений", async () => {
    const vec = [0.1, 0.2, 0.3, 0.4];
    const out = (await makeClient(4, vec).embed(["x"]))[0]!;
    expect(out).toEqual(vec);
  });

  it("модель отдаёт больше → обрезка до dim + L2-перенормировка", async () => {
    // 8-мерный вектор, целевая размерность 4.
    const vec = [3, 4, 9, 9, 100, 100, 100, 100];
    const out = (await makeClient(4, vec).embed(["x"]))[0]!;
    expect(out).toHaveLength(4);
    // Первые 4 компоненты [3,4,9,9] перенормированы: норма = sqrt(9+16+81+81)=sqrt(187).
    const norm = Math.sqrt(3 * 3 + 4 * 4 + 9 * 9 + 9 * 9);
    expect(out[0]).toBeCloseTo(3 / norm, 6);
    expect(out[1]).toBeCloseTo(4 / norm, 6);
    // Результат — единичный вектор.
    const outNorm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
    expect(outNorm).toBeCloseTo(1, 6);
  });

  it("модель отдаёт меньше → понятная ошибка (нельзя дофантазировать)", async () => {
    const promise = makeClient(4, [0.1, 0.2]).embed(["x"]);
    await expect(promise).rejects.toBeInstanceOf(EmbeddingApiError);
  });
});
