import { describe, expect, test } from "bun:test";
import { nextStage } from "../stage-router.ts";

const s = (
  lastUserMessage: string,
  currentStage: Parameters<typeof nextStage>[0]["currentStage"] = null,
  turnNumber = 2,
) => nextStage({ turnNumber, currentStage, lastUserMessage });

describe("objection detection", () => {
  test("'не уверена' → objection", () =>
    expect(s("не уверена, что это надёжно")).toBe("objection"));
  test("'боюсь' → objection", () =>
    expect(s("немного боюсь ехать")).toBe("objection"));
  test("'развод' → objection", () =>
    expect(s("это развод какой-то")).toBe("objection"));
  test("'не могу' → objection", () =>
    expect(s("не могу сейчас")).toBe("objection"));
  test("'подозрительно' → objection", () =>
    expect(s("как-то подозрительно звучит")).toBe("objection"));
});

describe("pitch trigger (info-seeking)", () => {
  test("'сколько' → pitch", () => expect(s("сколько платят?")).toBe("pitch"));
  test("'зарплата' → pitch", () => expect(s("какая зарплата?")).toBe("pitch"));
  test("'какие вакансии' → pitch", () =>
    expect(s("какие у вас вакансии?")).toBe("pitch"));
  test("'условия' → pitch", () =>
    expect(s("расскажи об условиях")).toBe("pitch"));
  test("'виза' → pitch", () =>
    expect(s("как оформляется виза?")).toBe("pitch"));
  test("'ktv' → pitch", () => expect(s("что за ktv работа?")).toBe("pitch"));
});

describe("close from agreement", () => {
  test("'давай' from pitch → close", () =>
    expect(s("ок, давай", "pitch")).toBe("close"));
  test("'согласна' from qualify → close", () =>
    expect(s("согласна, интересно", "qualify")).toBe("close"));
  test("'готов' from objection → close", () =>
    expect(s("готов попробовать", "objection")).toBe("close"));
  test("agreement from opener → stays in flow (not close)", () => {
    const result = s("ок", "opener");
    expect(result).not.toBe("close");
  });
});

describe("turn-based defaults", () => {
  test("turn 1 with no current stage → opener", () =>
    expect(
      nextStage({
        turnNumber: 1,
        currentStage: null,
        lastUserMessage: "привет",
      }),
    ).toBe("opener"));
  test("turn 1 keeps existing stage", () =>
    expect(
      nextStage({
        turnNumber: 1,
        currentStage: "qualify",
        lastUserMessage: "привет",
      }),
    ).toBe("qualify"));
  test("from opener → qualify on turn 2", () =>
    expect(s("расскажи", "opener", 2)).toBe("qualify"));
  test("from close → stays close", () =>
    expect(s("окей, спасибо", "close", 5)).toBe("close"));
});

describe("qualifier stays in qualify", () => {
  test("age mention keeps qualify", () =>
    expect(s("мне 25 лет", "qualify")).toBe("qualify"));
  test("experience mention keeps qualify", () =>
    expect(s("есть опыт работы официанткой", "qualify")).toBe("qualify"));
  test("city mention keeps qualify", () =>
    expect(s("я из города Казань", "qualify")).toBe("qualify"));
});

describe("objection beats everything", () => {
  test("objection overrides pricing keyword", () =>
    expect(s("сколько стоит, но боюсь рисков")).toBe("objection"));
});
