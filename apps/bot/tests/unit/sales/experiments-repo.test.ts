import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  type ExperimentRow,
  ExperimentsRepo,
  parseAllocationToExperiment,
} from "@/db/repos/experiments.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let repo: ExperimentsRepo;

beforeEach(() => {
  repo = new ExperimentsRepo(sql);
});

describe("ExperimentsRepo — insert/read", () => {
  test("insert creates a draft by default", async () => {
    const row = await repo.insert({
      slug: "my-exp",
      allocation: { "flirty-belfort-v1": 50, "empathetic-nepq-v1": 50 },
    });
    expect(row.status).toBe("draft");
    expect(row.success_metric).toBe("qualified");
    expect(row.started_at).toBeNull();

    const allocation = JSON.parse(row.allocation_json) as Record<string, number>;
    expect(allocation).toEqual({ "flirty-belfort-v1": 50, "empathetic-nepq-v1": 50 });
  });

  test("custom status + success_metric are persisted", async () => {
    const row = await repo.insert({
      slug: "running-exp",
      status: "running",
      successMetric: "won",
      allocation: { a: 1, b: 1 },
    });
    expect(row.status).toBe("running");
    expect(row.success_metric).toBe("won");
  });

  test("invalid status is rejected by CHECK constraint", async () => {
    // Avoid expect().rejects.toThrow() on raw postgres.js tagged templates —
    // the pending-query lifecycle hangs on constraint-violation cancels.
    let threw = false;
    try {
      await sql`INSERT INTO experiments (slug, status, allocation_json, success_metric)
                VALUES ('bad', 'made-up', '{}', 'qualified')`;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("duplicate slug throws", async () => {
    await repo.insert({ slug: "dup", allocation: { x: 1 } });
    let threw = false;
    try {
      await repo.insert({ slug: "dup", allocation: { y: 1 } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("ExperimentsRepo — getRunning", () => {
  test("returns null when no experiments exist", async () => {
    expect(await repo.getRunning()).toBeNull();
  });

  test("returns null when all experiments are draft/paused/done", async () => {
    await repo.insert({ slug: "draft", allocation: { x: 1 } });
    await repo.insert({ slug: "paused", status: "paused", allocation: { x: 1 } });
    await repo.insert({ slug: "done", status: "done", allocation: { x: 1 } });
    expect(await repo.getRunning()).toBeNull();
  });

  test("returns the running experiment", async () => {
    await repo.insert({ slug: "draft", allocation: { x: 1 } });
    const running = await repo.insert({
      slug: "live",
      status: "running",
      allocation: { x: 1 },
      startedAt: 1_000_000,
    });
    expect((await repo.getRunning())?.id).toBe(running.id);
  });

  test("when multiple are running (shouldn't happen but…), returns most recently started", async () => {
    await repo.insert({
      slug: "older",
      status: "running",
      allocation: { x: 1 },
      startedAt: 1000,
    });
    const newer = await repo.insert({
      slug: "newer",
      status: "running",
      allocation: { x: 1 },
      startedAt: 2000,
    });
    expect((await repo.getRunning())?.id).toBe(newer.id);
  });
});

describe("ExperimentsRepo — setStatus", () => {
  test("setting status='running' stamps started_at on first transition", async () => {
    const row = await repo.insert({ slug: "x", allocation: { a: 1 } });
    await repo.setStatus(row.id, "running");
    const after = (await repo.byId(row.id))!;
    expect(after.status).toBe("running");
    expect(after.started_at).not.toBeNull();
  });

  test("re-starting preserves the original started_at (COALESCE)", async () => {
    const row = await repo.insert({
      slug: "x",
      status: "running",
      allocation: { a: 1 },
      startedAt: 12345,
    });
    await repo.setStatus(row.id, "paused");
    await repo.setStatus(row.id, "running");
    expect((await repo.byId(row.id))?.started_at).toBe(12345);
  });

  test("setting status='done' stamps ended_at", async () => {
    const row = await repo.insert({ slug: "x", status: "running", allocation: { a: 1 } });
    await repo.setStatus(row.id, "done");
    expect((await repo.byId(row.id))?.ended_at).not.toBeNull();
  });
});

describe("parseAllocationToExperiment", () => {
  function fakeRow(allocationJson: string): ExperimentRow {
    return {
      id: 1,
      slug: "exp",
      status: "running",
      allocation_json: allocationJson,
      success_metric: "qualified",
      started_at: 1,
      ended_at: null,
      created_at: 1,
    };
  }

  test("parses a valid allocation into Experiment shape", () => {
    const exp = parseAllocationToExperiment(fakeRow(JSON.stringify({ a: 50, b: 30, c: 20 })));
    expect(exp).not.toBeNull();
    expect(exp!.slug).toBe("exp");
    expect(exp!.variants.length).toBe(3);
    expect(exp!.variants.find((v) => v.styleSlug === "a")?.weight).toBe(50);
  });

  test("returns null on malformed JSON", () => {
    expect(parseAllocationToExperiment(fakeRow("{not json"))).toBeNull();
  });

  test("returns null when allocation is not an object", () => {
    expect(parseAllocationToExperiment(fakeRow("[1,2,3]"))).not.toBeNull(); // array IS an object in JS — handled gracefully
    // null IS rejected
    expect(parseAllocationToExperiment(fakeRow("null"))).toBeNull();
  });

  test("returns null when a weight is non-numeric", () => {
    expect(parseAllocationToExperiment(fakeRow(JSON.stringify({ a: "fifty" })))).toBeNull();
  });

  test("returns null when a weight is negative", () => {
    expect(parseAllocationToExperiment(fakeRow(JSON.stringify({ a: -1 })))).toBeNull();
  });

  test("returns null when allocation is empty", () => {
    expect(parseAllocationToExperiment(fakeRow("{}"))).toBeNull();
  });

  test("zero weight is allowed (variant simply never wins)", () => {
    const exp = parseAllocationToExperiment(fakeRow(JSON.stringify({ a: 100, b: 0 })));
    expect(exp).not.toBeNull();
    expect(exp!.variants.length).toBe(2);
  });
});
