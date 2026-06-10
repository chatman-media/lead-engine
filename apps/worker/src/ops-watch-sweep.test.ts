// Unit-тесты per-tenant порога устаревания курсов + sweeper-механики на фейках.

import type { Db } from "@chatman-media/conversation-engine";
import { describe, expect, it, spyOn } from "bun:test";
import {
  effectiveStaleSec,
  type OpsAlert,
  type OpsAlertSink,
  OperationsWatchSweeper,
  type OpsWatchThresholds,
} from "./ops-watch-sweep.ts";

describe("effectiveStaleSec (per-tenant порог устаревания)", () => {
  it("явный feedStaleSec → берётся он", () => {
    expect(effectiveStaleSec(1200, { feedStaleSec: 600, rateRefreshSec: 120 })).toBe(600);
  });

  it("нет настройки → env-дефолт", () => {
    expect(effectiveStaleSec(1200, undefined)).toBe(1200);
  });

  it("авто: медленная частота → 3×refresh (выше env)", () => {
    // refresh 900с → 3× = 2700 > env 1200
    expect(effectiveStaleSec(1200, { rateRefreshSec: 900, feedStaleSec: null })).toBe(2700);
  });

  it("авто: быстрая частота → env-пол", () => {
    // refresh 120с → 3× = 360 < env 1200
    expect(effectiveStaleSec(1200, { rateRefreshSec: 120, feedStaleSec: null })).toBe(1200);
  });
});

// ── Sweeper-механика на фейках (без БД) ─────────────────────────────────────

const THRESHOLDS: OpsWatchThresholds = {
  feedStaleMin: 20,
  stuckOrderMin: 45,
  volumeSpikeThb: 0,
  alertCooldownMin: 60,
};

/** db.select().from().where() → rows; transaction отсутствует → withTenant падает. */
function fakeDbWithTenants(rows: Array<{ id: number }>): Db {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as Db;
}

/** db.select() кидает сразу → sweep() reject'ится (error-ветка run-loop'а). */
function fakeDbThrows(err: Error): Db {
  return {
    select: () => {
      throw err;
    },
  } as unknown as Db;
}

class NoopSink implements OpsAlertSink {
  async emit(_alert: OpsAlert): Promise<void> {}
}

describe("OperationsWatchSweeper: run/stop/sweep на фейках", () => {
  it("run: sweep-ошибка логируется, abort останавливает loop", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const sweeper = new OperationsWatchSweeper(fakeDbThrows(new Error("db down")), {
        intervalMs: 1,
        sink: new NoopSink(),
        thresholds: THRESHOLDS,
      });
      const ac = new AbortController();
      const done = sweeper.run(ac.signal);
      await new Promise((r) => setTimeout(r, 25));
      ac.abort();
      await done;
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[ops-watch] error"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("stop() до run() → loop не стартует (мгновенный return)", async () => {
    const sweeper = new OperationsWatchSweeper(fakeDbThrows(new Error("never called")), {
      intervalMs: 1,
      sink: new NoopSink(),
      thresholds: THRESHOLDS,
    });
    sweeper.stop();
    await sweeper.run(); // без сигнала: ветка `signal?.` тоже покрыта
  });

  it("sweep: ошибка sweepTenant per-tenant ловится, остальные тенанты не страдают", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // fake db без transaction → withTenant внутри sweepTenant кидает per-tenant.
      const sweeper = new OperationsWatchSweeper(fakeDbWithTenants([{ id: 1 }, { id: 2 }]), {
        intervalMs: 1,
        sink: new NoopSink(),
        thresholds: THRESHOLDS,
      });
      await sweeper.sweep(); // не должен кинуть наружу
      const tenantErrors = errSpy.mock.calls.filter((c) =>
        String(c[0]).startsWith("[ops-watch] tenant="),
      );
      expect(tenantErrors).toHaveLength(2);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("emit: падение sink'а логируется и не рвёт sweep; cooldown давит повтор", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      let calls = 0;
      const throwingSink: OpsAlertSink = {
        emit: async () => {
          calls += 1;
          throw new Error("telegram down");
        },
      };
      const sweeper = new OperationsWatchSweeper(fakeDbWithTenants([]), {
        intervalMs: 1,
        sink: throwingSink,
        thresholds: THRESHOLDS,
      });
      const alert: OpsAlert = {
        tenantId: 1,
        kind: "rate_feed_stale",
        severity: "warning",
        title: "t",
        detail: "d",
        dedupKey: "rate_feed_stale",
      };
      const emit = (
        sweeper as unknown as { emit: (a: OpsAlert, now: number) => Promise<void> }
      ).emit.bind(sweeper);
      await emit(alert, 1000); // sink кинул → поймали + console.error
      expect(calls).toBe(1);
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("[ops-watch] sink emit failed")),
      ).toBe(true);
      await emit(alert, 1000 + 5); // в пределах cooldown → sink не зовётся
      expect(calls).toBe(1);
      await emit(alert, 1000 + THRESHOLDS.alertCooldownMin * 60 + 1); // cooldown истёк
      expect(calls).toBe(2);
    } finally {
      errSpy.mockRestore();
    }
  });
});
