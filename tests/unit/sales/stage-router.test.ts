import { describe, expect, test } from "bun:test";
import { nextStage } from "../../../src/sales/stage-router.ts";
import type { FunnelStage } from "../../../src/sales/types.ts";

const start = (lastUserMessage: string): {
  turnNumber: number;
  currentStage: FunnelStage | null;
  lastUserMessage: string;
} => ({
  turnNumber: 1,
  currentStage: null,
  lastUserMessage,
});

describe("nextStage — Cyrillic-aware regex (regression for the \\b bug)", () => {
  test("'сколько в Дубае платят?' → pitch (the original bug)", () => {
    expect(
      nextStage({ turnNumber: 2, currentStage: "qualify", lastUserMessage: "а сколько в Дубае платят?" }),
    ).toBe("pitch");
  });

  test("'гонорар какой?' → pitch", () => {
    expect(
      nextStage({ turnNumber: 2, currentStage: "qualify", lastUserMessage: "гонорар какой?" }),
    ).toBe("pitch");
  });

  test("'нужна виза для Турции?' → pitch", () => {
    expect(
      nextStage({ turnNumber: 2, currentStage: "qualify", lastUserMessage: "нужна виза для Турции?" }),
    ).toBe("pitch");
  });

  test("'я сомневаюсь в этом' → objection", () => {
    expect(
      nextStage({ turnNumber: 3, currentStage: "pitch", lastUserMessage: "я сомневаюсь в этом" }),
    ).toBe("objection");
  });

  test("'это не развод?' → objection", () => {
    expect(
      nextStage({ turnNumber: 2, currentStage: "qualify", lastUserMessage: "а это не развод?" }),
    ).toBe("objection");
  });

  test("'боюсь лететь одна' → objection", () => {
    expect(
      nextStage({ turnNumber: 3, currentStage: "pitch", lastUserMessage: "боюсь лететь одна" }),
    ).toBe("objection");
  });
});

describe("nextStage — turn-1 routing", () => {
  test("first message stays on opener", () => {
    expect(nextStage(start("привет"))).toBe("opener");
  });

  test("first message with greeting stays on opener", () => {
    expect(nextStage(start("здравствуйте"))).toBe("opener");
  });

  // Pricing/objection regexes fire even on turn 1 — they take precedence over
  // the turn-1-stays-on-opener rule. This is intentional: if a prospect opens
  // with "сколько у вас платят?" we should jump straight to pitch.
  test("first message with pricing question jumps to pitch", () => {
    expect(nextStage(start("сколько платят в Дубае?"))).toBe("pitch");
  });
});

describe("nextStage — flow transitions", () => {
  test("opener → qualify even with agreement keyword (won't fast-forward to close)", () => {
    // "интересно" matches agreement, but agreement only triggers `close` from
    // qualify/pitch/objection. From opener, polite "интересно" just engages the
    // qualify stage — we haven't earned the close yet.
    expect(
      nextStage({
        turnNumber: 2,
        currentStage: "opener",
        lastUserMessage: "интересно, расскажите подробнее",
      }),
    ).toBe("qualify");
  });

  test("opener → qualify on a generic follow-up without keywords", () => {
    expect(
      nextStage({
        turnNumber: 2,
        currentStage: "opener",
        lastUserMessage: "ну расскажи",
      }),
    ).toBe("qualify");
  });

  test("qualify stays on qualify when prospect provides qualifier info", () => {
    expect(
      nextStage({
        turnNumber: 3,
        currentStage: "qualify",
        lastUserMessage: "мне 22 года, живу в Москве",
      }),
    ).toBe("qualify");
  });

  test("agreement after pitch → close", () => {
    expect(
      nextStage({
        turnNumber: 4,
        currentStage: "pitch",
        lastUserMessage: "ок, давай попробую",
      }),
    ).toBe("close");
  });

  test("agreement after qualify → close", () => {
    expect(
      nextStage({
        turnNumber: 3,
        currentStage: "qualify",
        lastUserMessage: "интересно",
      }),
    ).toBe("close");
  });

  test("agreement after objection → close", () => {
    expect(
      nextStage({
        turnNumber: 4,
        currentStage: "objection",
        lastUserMessage: "ладно, готова",
      }),
    ).toBe("close");
  });

  test("close stays on close", () => {
    expect(
      nextStage({
        turnNumber: 5,
        currentStage: "close",
        lastUserMessage: "когда созвонимся?",
      }),
    ).toBe("close");
  });

  test("falls back to qualify when nothing matches", () => {
    expect(
      nextStage({
        turnNumber: 5,
        currentStage: null,
        lastUserMessage: "хм",
      }),
    ).toBe("qualify");
  });
});

describe("nextStage — precedence", () => {
  test("objection beats pricing when both keywords are present", () => {
    expect(
      nextStage({
        turnNumber: 3,
        currentStage: "pitch",
        lastUserMessage: "не уверена насчёт сколько платят",
      }),
    ).toBe("objection");
  });

  test("pricing beats agreement when both are present", () => {
    expect(
      nextStage({
        turnNumber: 3,
        currentStage: "qualify",
        lastUserMessage: "ок, а сколько платят?",
      }),
    ).toBe("pitch");
  });
});
