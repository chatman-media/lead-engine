import { describe, expect, it } from "bun:test";
import { checkRateGuard, type ExchangeGuardrails } from "./guardrails.ts";

const G: ExchangeGuardrails = { maxDeviationPct: 35, epsPct: 0.5 };

describe("checkRateGuard — грубое отклонение блокируется", () => {
  it("опечатка tier (10 при рынке 35, −71%) → implausible_deviation", () => {
    const r = checkRateGuard({ eff: 10, baseRate: 35, mode: "multiply", guardrails: G });
    expect(r.tripped).toBe(true);
    expect(r.reason).toBe("implausible_deviation");
    expect(r.deviationPct).toBeCloseTo(-71.43, 1);
  });

  it("курс сильно выше рынка (50 при базе 35, +43%) → implausible_deviation", () => {
    const r = checkRateGuard({ eff: 50, baseRate: 35, mode: "multiply", guardrails: G });
    expect(r.tripped).toBe(true);
    expect(r.reason).toBe("implausible_deviation");
  });

  it("нулевой eff → nonpositive", () => {
    const r = checkRateGuard({ eff: 0, baseRate: 35, mode: "multiply", guardrails: G });
    expect(r.tripped).toBe(true);
    expect(r.reason).toBe("nonpositive");
  });

  it("RUB-опечатка (10 при базе 2.55) → implausible_deviation", () => {
    const r = checkRateGuard({ eff: 10, baseRate: 2.55, mode: "divide", guardrails: G });
    expect(r.tripped).toBe(true);
    expect(r.reason).toBe("implausible_deviation");
  });
});

describe("checkRateGuard — легальные котировки проходят", () => {
  it("обычная маржа ~3% (eff 34, base 35)", () => {
    const r = checkRateGuard({ eff: 34, baseRate: 35, mode: "multiply", guardrails: G });
    expect(r.tripped).toBe(false);
  });

  // Реальные тарифы forsanya: объёмные RUB-тарифы намеренно НИЖЕ base (volume discount).
  it.each([2.64, 2.59, 2.52, 2.48, 2.39])(
    "RUB volume-tier %p при базе 2.55 не роняет guard",
    (displayRate) => {
      const r = checkRateGuard({ eff: displayRate, baseRate: 2.55, mode: "divide", guardrails: G });
      expect(r.tripped).toBe(false);
    },
  );

  it.each([31.35, 31.45, 31.7])("USDT-тариф %p при базе 31.5 проходит", (displayRate) => {
    const r = checkRateGuard({ eff: displayRate, baseRate: 31.5, mode: "multiply", guardrails: G });
    expect(r.tripped).toBe(false);
  });
});

describe("checkRateGuard — крайние случаи и конфиг", () => {
  it("невалидная база (≤0) — оценить нельзя, не роняем (ловят другие проверки)", () => {
    const r = checkRateGuard({ eff: 31, baseRate: 0, mode: "multiply", guardrails: G });
    expect(r.tripped).toBe(false);
    expect(Number.isNaN(r.deviationPct)).toBe(true);
  });

  it("кастомный порог maxDeviationPct уважается", () => {
    // eff 21 при базе 35 → −40%
    const loose: ExchangeGuardrails = { maxDeviationPct: 50, epsPct: 0.5 };
    expect(
      checkRateGuard({ eff: 21, baseRate: 35, mode: "multiply", guardrails: loose }).tripped,
    ).toBe(false);
    expect(
      checkRateGuard({ eff: 21, baseRate: 35, mode: "multiply", guardrails: G }).tripped,
    ).toBe(true);
  });
});
