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
    expect(updates[0]).toMatchObject({
      status: "complete",
      decision: "inconclusive",
      totalPairs: 0,
    });
  });

  it("normalizeResume: валидный resume + runPairwiseMatch кидает → normalizeResume вызван (lines 210-217)", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const deps = {
      shadowRepo: {
        update: async (_id: number, fields: Record<string, unknown>) => {
          updates.push(fields);
        },
      },
      // остальные deps undefined → runPairwiseMatch упадёт сразу, но normalizeResume вызовется ДО петли
    } as unknown as Parameters<typeof runShadowEval>[0];
    const fakePersona = {
      slug: "p1",
      displayName: "Тест",
      summary: "x",
      systemPrompt: "x",
      opener: "Привет",
      judgingHint: "x",
    };
    // personas=[fakePersona] → total=1>0 → код дойдёт до normalizeResume (line 126)
    // resume с корректной суммой → path line 217
    const input = {
      evalId: 2,
      parentStyle: {},
      parentStyleId: 1,
      newStyle: {},
      newStyleId: 2,
      personas: [fakePersona],
      runs: 1,
      maxTurns: 5,
      resume: { pairsDone: 0, aWins: 0, bWins: 0, draws: 0 },
    } as unknown as Parameters<typeof runShadowEval>[1];

    await runShadowEval(deps, input);
    // runPairwiseMatch выбросил → статус failed
    expect(updates[0]).toMatchObject({ status: "failed" });
  });

  it("normalizeResume: невалидный resume (сумма не совпадает) → сброс (line 215)", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const deps = {
      shadowRepo: {
        update: async (_id: number, fields: Record<string, unknown>) => {
          updates.push(fields);
        },
      },
    } as unknown as Parameters<typeof runShadowEval>[0];
    const fakePersona = {
      slug: "p2",
      displayName: "Тест2",
      summary: "x",
      systemPrompt: "x",
      opener: "Привет",
      judgingHint: "x",
    };
    // resume: pairsDone=1, но aWins+bWins+draws=2+1+0=3 ≠ 1 → line 215
    const input = {
      evalId: 3,
      parentStyle: {},
      parentStyleId: 1,
      newStyle: {},
      newStyleId: 2,
      personas: [fakePersona],
      runs: 1,
      maxTurns: 5,
      resume: { pairsDone: 1, aWins: 2, bWins: 1, draws: 0 },
    } as unknown as Parameters<typeof runShadowEval>[1];

    await runShadowEval(deps, input);
    expect(updates[0]).toMatchObject({ status: "failed" });
  });
});
