import { describe, expect, test } from "bun:test";
import type { ExperimentRow } from "./dal/index.ts";
import { loadExperimentVariants } from "./experiment-router.ts";

function makeExperiment(allocationJson: string): ExperimentRow {
  return {
    id: 1,
    tenantId: 1,
    slug: "test-exp",
    status: "running",
    allocationJson,
    successMetric: "qualified",
    startedAt: null,
    endedAt: null,
    createdAt: 0,
  };
}

const VALID_CONFIG_JSON = JSON.stringify({
  slug: "test-style",
  displayName: "Test",
  persona: { name: "Марина", role: "human", company: "ACME" },
  voice: { tone: "дружелюбный", language: "ru" },
  framework: "SPIN",
  stages: { qualify: { goal: "понять запрос" } },
  guardrails: {},
  model: {},
});

describe("loadExperimentVariants", () => {
  test("все стили missing → возвращает null", async () => {
    const result = await loadExperimentVariants(
      makeExperiment(JSON.stringify([{ styleSlug: "missing", weight: 1 }])),
      { findActiveBySlug: async () => null } as never,
    );
    expect(result).toBeNull();
  });

  test("возвращает null когда style не найден", async () => {
    const result = await loadExperimentVariants(
      makeExperiment(JSON.stringify([{ styleSlug: "missing", weight: 1 }])),
      { findActiveBySlug: async () => null } as never,
    );
    expect(result).toBeNull();
  });

  test("возвращает null когда configJson невалидный", async () => {
    const result = await loadExperimentVariants(
      makeExperiment(JSON.stringify([{ styleSlug: "bad", weight: 1 }])),
      { findActiveBySlug: async () => ({ configJson: "{invalid json}" }) } as never,
    );
    expect(result).toBeNull();
  });

  test("возвращает variants для валидного стиля", async () => {
    const result = await loadExperimentVariants(
      makeExperiment(JSON.stringify([{ styleSlug: "test-style", weight: 0.6 }])),
      { findActiveBySlug: async () => ({ configJson: VALID_CONFIG_JSON }) } as never,
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.weight).toBe(0.6);
    expect(result![0]!.style.slug).toBe("test-style");
  });

  test("пропускает missing стиль, возвращает валидные", async () => {
    let call = 0;
    const mixedRepo = {
      findActiveBySlug: async () => (++call === 1 ? null : { configJson: VALID_CONFIG_JSON }),
    };
    const result = await loadExperimentVariants(
      makeExperiment(
        JSON.stringify([
          { styleSlug: "missing", weight: 0.3 },
          { styleSlug: "valid", weight: 0.7 },
        ]),
      ),
      mixedRepo as never,
    );
    expect(result).toHaveLength(1);
    expect(result![0]!.weight).toBe(0.7);
  });
});
