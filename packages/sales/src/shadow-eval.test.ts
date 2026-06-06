import { describe, expect, it } from "bun:test";
import { runShadowEval, shadowDecide } from "./shadow-eval.ts";

describe("shadowDecide", () => {
  it("total=0 → inconclusive", () => {
    expect(shadowDecide(0, 0)).toBe("inconclusive");
  });
  it("явное улучшение B → keep", () => {
    expect(shadowDecide(98, 100)).toBe("keep");
  });
  it("явная регрессия B → rollback", () => {
    expect(shadowDecide(2, 100)).toBe("rollback");
  });
  it("середина (Wilson LB между порогами) → inconclusive", () => {
    expect(shadowDecide(62, 100)).toBe("inconclusive");
  });
});

describe("runShadowEval", () => {
  it("нет персон → complete/inconclusive/totalPairs=0 без прогона матчей", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const deps = {
      shadowRepo: {
        update: async (_id: number, fields: Record<string, unknown>) => {
          updates.push(fields);
        },
      },
    } as unknown as Parameters<typeof runShadowEval>[0];
    const input = {
      evalId: 1,
      parentStyle: {},
      parentStyleId: 1,
      newStyle: {},
      newStyleId: 2,
      personas: [],
      runs: 2,
      maxTurns: 5,
    } as unknown as Parameters<typeof runShadowEval>[1];

    await runShadowEval(deps, input);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "complete", decision: "inconclusive", totalPairs: 0 });
  });
});
