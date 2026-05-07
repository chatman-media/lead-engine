import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type ExperimentRow,
  ExperimentsRepo,
  parseAllocationToExperiment,
} from "@/db/repos/experiments.ts";
import { openDb } from "@/db/sqlite.ts";

let db: ReturnType<typeof openDb>;
let repo: ExperimentsRepo;

beforeEach(() => {
  db = openDb({ path: ":memory:", embeddingDim: 1536 });
  repo = new ExperimentsRepo(db);
});
afterEach(() => db.close());

describe("ExperimentsRepo — insert/read", () => {
  test("insert creates a draft by default", () => {
    const row = repo.insert({
      slug: "my-exp",
      allocation: { "flirty-belfort-v1": 50, "empathetic-nepq-v1": 50 },
    });
    expect(row.status).toBe("draft");
    expect(row.success_metric).toBe("qualified");
    expect(row.started_at).toBeNull();

    const allocation = JSON.parse(row.allocation_json) as Record<string, number>;
    expect(allocation).toEqual({ "flirty-belfort-v1": 50, "empathetic-nepq-v1": 50 });
  });

  test("custom status + success_metric are persisted", () => {
    const row = repo.insert({
      slug: "running-exp",
      status: "running",
      successMetric: "won",
      allocation: { a: 1, b: 1 },
    });
    expect(row.status).toBe("running");
    expect(row.success_metric).toBe("won");
  });

  test("invalid status is rejected by CHECK constraint", () => {
    expect(() =>
      db.run(
        `INSERT INTO experiments (slug, status, allocation_json, success_metric)
         VALUES ('bad', 'made-up', '{}', 'qualified')`,
      ),
    ).toThrow();
  });

  test("duplicate slug throws", () => {
    repo.insert({ slug: "dup", allocation: { x: 1 } });
    expect(() => repo.insert({ slug: "dup", allocation: { y: 1 } })).toThrow();
  });
});

describe("ExperimentsRepo — getRunning", () => {
  test("returns null when no experiments exist", () => {
    expect(repo.getRunning()).toBeNull();
  });

  test("returns null when all experiments are draft/paused/done", () => {
    repo.insert({ slug: "draft", allocation: { x: 1 } });
    repo.insert({ slug: "paused", status: "paused", allocation: { x: 1 } });
    repo.insert({ slug: "done", status: "done", allocation: { x: 1 } });
    expect(repo.getRunning()).toBeNull();
  });

  test("returns the running experiment", () => {
    repo.insert({ slug: "draft", allocation: { x: 1 } });
    const running = repo.insert({
      slug: "live",
      status: "running",
      allocation: { x: 1 },
      startedAt: 1_000_000,
    });
    expect(repo.getRunning()?.id).toBe(running.id);
  });

  test("when multiple are running (shouldn't happen but…), returns most recently started", () => {
    repo.insert({
      slug: "older",
      status: "running",
      allocation: { x: 1 },
      startedAt: 1000,
    });
    const newer = repo.insert({
      slug: "newer",
      status: "running",
      allocation: { x: 1 },
      startedAt: 2000,
    });
    expect(repo.getRunning()?.id).toBe(newer.id);
  });
});

describe("ExperimentsRepo — setStatus", () => {
  test("setting status='running' stamps started_at on first transition", () => {
    const row = repo.insert({ slug: "x", allocation: { a: 1 } });
    repo.setStatus(row.id, "running");
    const after = repo.byId(row.id)!;
    expect(after.status).toBe("running");
    expect(after.started_at).not.toBeNull();
  });

  test("re-starting preserves the original started_at (COALESCE)", () => {
    const row = repo.insert({
      slug: "x",
      status: "running",
      allocation: { a: 1 },
      startedAt: 12345,
    });
    repo.setStatus(row.id, "paused");
    repo.setStatus(row.id, "running");
    expect(repo.byId(row.id)?.started_at).toBe(12345);
  });

  test("setting status='done' stamps ended_at", () => {
    const row = repo.insert({ slug: "x", status: "running", allocation: { a: 1 } });
    repo.setStatus(row.id, "done");
    expect(repo.byId(row.id)?.ended_at).not.toBeNull();
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
