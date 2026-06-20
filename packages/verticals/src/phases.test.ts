import { describe, expect, it } from "bun:test";
import {
  buildSkeletonFunnel,
  deriveDefaultPhase,
  effectivePhase,
  type PhaseStageLike,
  validateBackbone,
} from "./phases.ts";

describe("effectivePhase", () => {
  it("выводит якоря из kind", () => {
    expect(effectivePhase({ kind: "intake" })).toBe("capture");
    expect(effectivePhase({ kind: "terminal_won" })).toBe("won");
    expect(effectivePhase({ kind: "terminal_lost" })).toBe("lost");
  });
  it("для active берёт хранимую phase", () => {
    expect(effectivePhase({ kind: "active", phase: "offer" })).toBe("offer");
  });
  it("игнорирует phase на якорных kind (kind — источник истины)", () => {
    expect(effectivePhase({ kind: "terminal_won", phase: "offer" })).toBe("won");
  });
  it("active без валидной phase → null", () => {
    expect(effectivePhase({ kind: "active" })).toBeNull();
    expect(effectivePhase({ kind: "active", phase: "bogus" })).toBeNull();
  });
});

describe("deriveDefaultPhase", () => {
  it("маппит типы стадий на фазы", () => {
    expect(deriveDefaultPhase("rate_confirmation", null)).toBe("offer");
    expect(deriveDefaultPhase("document_signature", "qualify")).toBe("offer");
    expect(deriveDefaultPhase("external_approval", "offer")).toBe("clear");
    expect(deriveDefaultPhase("document_upload", "offer")).toBe("clear");
    expect(deriveDefaultPhase("payment", "clear")).toBe("fulfill");
    expect(deriveDefaultPhase("assessment", null)).toBe("qualify");
    expect(deriveDefaultPhase("assessment", "offer")).toBe("clear");
    expect(deriveDefaultPhase("form_fill", null)).toBe("qualify");
  });

  it("waiting: до fulfill → clear, после/на fulfill → fulfill", () => {
    expect(deriveDefaultPhase("waiting", null)).toBe("clear");
    expect(deriveDefaultPhase("waiting", "clear")).toBe("clear");
    expect(deriveDefaultPhase("waiting", "fulfill")).toBe("fulfill");
  });

  it("interaction: до offer → qualify, после offer → fulfill", () => {
    expect(deriveDefaultPhase("interaction", null)).toBe("qualify");
    expect(deriveDefaultPhase("interaction", "qualify")).toBe("qualify");
    expect(deriveDefaultPhase("interaction", "offer")).toBe("fulfill");
  });

  it("milestone: продвигает фазу на одну ступень вперёд", () => {
    expect(deriveDefaultPhase("milestone", null)).toBe("qualify");
    expect(deriveDefaultPhase("milestone", "qualify")).toBe("offer");
    expect(deriveDefaultPhase("milestone", "offer")).toBe("fulfill");
    expect(deriveDefaultPhase("milestone", "fulfill")).toBe("fulfill");
  });
});

describe("validateBackbone", () => {
  const won: PhaseStageLike = {
    slug: "won",
    kind: "terminal_won",
    position: 90,
    nextStages: [],
  };
  const lost: PhaseStageLike = {
    slug: "lost",
    kind: "terminal_lost",
    position: 91,
    nextStages: [],
  };
  const intakeTo = (next: string[]): PhaseStageLike => ({
    slug: "in",
    kind: "intake",
    position: 0,
    nextStages: next,
  });

  it("валидная воронка — без ошибок и предупреждений", () => {
    const v = validateBackbone([
      intakeTo(["q"]),
      { slug: "q", kind: "active", phase: "qualify", position: 1, nextStages: ["o"] },
      { slug: "o", kind: "active", phase: "offer", position: 2, nextStages: ["won", "lost"] },
      won,
      lost,
    ]);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it("нет terminal_won → ошибка", () => {
    const v = validateBackbone([
      intakeTo(["o"]),
      { slug: "o", kind: "active", phase: "offer", position: 1, nextStages: ["lost"] },
      lost,
    ]);
    expect(v.errors.some((e) => e.includes("terminal_won"))).toBe(true);
  });

  it("нарушение порядка фаз (clear до offer) → ошибка", () => {
    const v = validateBackbone([
      intakeTo(["c"]),
      { slug: "c", kind: "active", phase: "clear", position: 1, nextStages: ["o"] },
      { slug: "o", kind: "active", phase: "offer", position: 2, nextStages: ["won", "lost"] },
      won,
      lost,
    ]);
    expect(v.errors.some((e) => e.includes("порядок"))).toBe(true);
  });

  it("нет qualify → предупреждение, а не ошибка (SaaS-подобная воронка)", () => {
    const v = validateBackbone([
      intakeTo(["o"]),
      { slug: "o", kind: "active", phase: "offer", position: 1, nextStages: ["won", "lost"] },
      won,
      lost,
    ]);
    expect(v.errors).toEqual([]);
    expect(v.warnings.some((w) => w.includes("qualify"))).toBe(true);
  });

  it("битая ссылка nextStages → ошибка", () => {
    const v = validateBackbone([
      intakeTo(["o"]),
      {
        slug: "o",
        kind: "active",
        phase: "offer",
        position: 1,
        nextStages: ["nope", "won", "lost"],
      },
      won,
      lost,
    ]);
    expect(v.errors.some((e) => e.includes("nextStages"))).toBe(true);
  });

  it("нет стадии intake (intakeCount=0) → ошибка про intake", () => {
    const v = validateBackbone([
      { slug: "o", kind: "active", phase: "offer", position: 1, nextStages: ["won", "lost"] },
      won,
      lost,
    ]);
    expect(v.errors.some((e) => e.includes("intake"))).toBe(true);
  });

  it("нет terminal_lost → ошибка", () => {
    const v = validateBackbone([
      intakeTo(["o"]),
      { slug: "o", kind: "active", phase: "offer", position: 1, nextStages: ["won"] },
      won,
    ]);
    expect(v.errors.some((e) => e.includes("terminal_lost"))).toBe(true);
  });

  it("active-стадия без валидной phase → ошибка про классификацию", () => {
    const v = validateBackbone([
      intakeTo(["x"]),
      { slug: "x", kind: "active", phase: undefined, position: 1, nextStages: ["won", "lost"] },
      won,
      lost,
    ]);
    expect(v.errors.some((e) => e.includes("классифицируется"))).toBe(true);
  });
});

describe("buildSkeletonFunnel", () => {
  it("дефолт (qualify/offer/fulfill) проходит костяк без замечаний", () => {
    const v = validateBackbone(buildSkeletonFunnel());
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it("полный (с clear) — все 7 этапов в правильном порядке", () => {
    const stages = buildSkeletonFunnel({ includeClear: true });
    expect(stages.map((s) => s.slug)).toEqual([
      "new",
      "qualify",
      "offer",
      "clear",
      "fulfill",
      "won",
      "lost",
    ]);
    const v = validateBackbone(stages);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it("минимальный (без clear/fulfill) — только qualify+offer между якорями", () => {
    const stages = buildSkeletonFunnel({ includeFulfill: false });
    expect(stages.map((s) => s.slug)).toEqual(["new", "qualify", "offer", "won", "lost"]);
    const v = validateBackbone(stages);
    expect(v.errors).toEqual([]);
    // последний рабочий этап (offer) ведёт в won
    expect(stages.find((s) => s.slug === "offer")?.nextStages).toEqual(["won", "lost"]);
  });
});
