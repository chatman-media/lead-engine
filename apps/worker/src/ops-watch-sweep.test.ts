// Unit-тесты per-tenant порога устаревания курсов.

import { describe, expect, it } from "bun:test";
import { effectiveStaleSec } from "./ops-watch-sweep.ts";

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
