/**
 * Unit tests for StaleleadSweeper lifecycle — stop/abort mechanics.
 * The actual SQL sweep logic is covered by admin-leads integration tests
 * (leads that exceed staleTimeoutDays in a real DB).
 */

import { describe, expect, it, mock } from "bun:test";
import { StaleleadSweeper } from "./stale-lead-sweep.ts";

function makeDb(tenants: { id: number }[] = []) {
  return {
    select: () => ({
      from: () => ({
        where: async () => tenants,
      }),
    }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(makeDb()),
    execute: async () => {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any;
}

describe("StaleleadSweeper", () => {
  it("stop() halts the run loop before next iteration", async () => {
    const db = makeDb([]);
    const sweeper = new StaleleadSweeper(db, { intervalMs: 50 });

    let ran = 0;
    (sweeper as unknown as { sweep: () => Promise<void> }).sweep = async () => {
      ran++;
    };

    const runPromise = sweeper.run();
    await new Promise((r) => setTimeout(r, 10));
    sweeper.stop();
    await runPromise;

    expect(ran).toBeGreaterThanOrEqual(1);
  });

  it("AbortSignal halts the loop", async () => {
    const db = makeDb([]);
    const sweeper = new StaleleadSweeper(db, { intervalMs: 50 });

    const controller = new AbortController();
    (sweeper as unknown as { sweep: () => Promise<void> }).sweep = async () => {};

    const runPromise = sweeper.run(controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await runPromise;
    // Completes without hanging
    expect(true).toBe(true);
  });

  it("sweep errors are caught and don't crash the loop", async () => {
    const db = makeDb([]);
    const sweeper = new StaleleadSweeper(db, { intervalMs: 20 });
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    let calls = 0;
    (sweeper as unknown as { sweep: () => Promise<void> }).sweep = async () => {
      calls++;
      if (calls === 1) throw new Error("transient DB error");
    };

    try {
      const runPromise = sweeper.run();
      // Give enough time for 2+ iterations
      await new Promise((r) => setTimeout(r, 55));
      sweeper.stop();
      await runPromise;
    } finally {
      console.error = originalError;
    }

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
