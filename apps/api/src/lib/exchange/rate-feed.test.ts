// Unit-тесты чистой логики планировщика курсов (per-tenant частота).

import { describe, expect, it } from "bun:test";
import { isRefreshDue } from "./rate-feed.ts";

describe("isRefreshDue (тик-планировщик)", () => {
  it("нет прошлого рефреша → due", () => {
    expect(isRefreshDue(1000, undefined, 180)).toBe(true);
  });

  it("прошло меньше интервала → не due", () => {
    expect(isRefreshDue(1000, 900, 180)).toBe(false); // 100с < 180
  });

  it("прошло ровно интервал → due", () => {
    expect(isRefreshDue(1000, 820, 180)).toBe(true); // 180 >= 180
  });

  it("прошло больше интервала → due", () => {
    expect(isRefreshDue(1000, 700, 180)).toBe(true); // 300 >= 180
  });
});
