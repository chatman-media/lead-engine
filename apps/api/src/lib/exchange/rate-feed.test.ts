// Unit-тесты чистой логики планировщика курсов (per-tenant частота) +
// классификации отклонения фида (auto/pending/freeze, #732).

import { describe, expect, it } from "bun:test";
import { classifyRateChange, isRefreshDue } from "./rate-feed.ts";

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

describe("classifyRateChange (#732 — пороги фида)", () => {
  // Стандартный набор: soft 5%, hard 50%.
  const T = { soft: 0.05, hard: 0.5 } as const;

  it("первичная установка (prev<=0) → auto", () => {
    const r = classifyRateChange(0, 36, T);
    expect(r.decision).toBe("auto");
    expect(r.nextValid).toBe(true);
  });

  it("негодный next (NaN/<=0) → auto + nextValid=false", () => {
    const r1 = classifyRateChange(36, 0, T);
    expect(r1.nextValid).toBe(false);
    const r2 = classifyRateChange(36, Number.NaN, T);
    expect(r2.nextValid).toBe(false);
  });

  it("в пределах soft → auto", () => {
    const r = classifyRateChange(100, 104, T); // +4%
    expect(r.decision).toBe("auto");
  });

  it("в диапазоне soft..hard → pending (severity=soft)", () => {
    const r = classifyRateChange(100, 110, T); // +10%
    expect(r.decision).toBe("pending");
    expect(r.severity).toBe("soft");
  });

  it("за hard → freeze (severity=hard)", () => {
    const r = classifyRateChange(100, 200, T); // +100%
    expect(r.decision).toBe("freeze");
    expect(r.severity).toBe("hard");
  });

  it("отрицательное отклонение симметрично", () => {
    const pending = classifyRateChange(100, 90, T); // -10%
    expect(pending.decision).toBe("pending");
    const freeze = classifyRateChange(100, 40, T); // -60%
    expect(freeze.decision).toBe("freeze");
  });

  it("requireConfirm=true → даже мелкий тик идёт в pending", () => {
    const r = classifyRateChange(100, 101, { ...T, requireConfirm: true });
    expect(r.decision).toBe("pending");
    expect(r.severity).toBe("soft");
  });

  it("requireConfirm не отменяет freeze (sanity > hard)", () => {
    const r = classifyRateChange(100, 250, { ...T, requireConfirm: true });
    expect(r.decision).toBe("freeze");
  });

  it("deviation — знаковая доля", () => {
    const up = classifyRateChange(100, 110, T);
    expect(up.deviation).toBeCloseTo(0.1, 6);
    const down = classifyRateChange(100, 90, T);
    expect(down.deviation).toBeCloseTo(-0.1, 6);
  });
});
