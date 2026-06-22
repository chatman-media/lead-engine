import { describe, expect, it } from "bun:test";
import { digestKeyboard, levelKeyboard, topicMap, topicsKeyboard } from "./operator-informer-ui.ts";

type Btn = { text: string; callback_data: string };
const rows = (m: { inline_keyboard?: unknown[][] }): Btn[] =>
  (m.inline_keyboard ?? []).map((r) => r[0] as Btn);

describe("levelKeyboard", () => {
  it("маркирует текущий уровень точкой, callback lvl:<level>", () => {
    const btns = rows(levelKeyboard("important"));
    expect(btns.map((b) => b.callback_data)).toEqual([
      "lvl:silent",
      "lvl:critical",
      "lvl:important",
      "lvl:all",
    ]);
    expect(btns.find((b) => b.callback_data === "lvl:important")?.text).toContain("•");
    expect(btns.find((b) => b.callback_data === "lvl:silent")?.text).not.toContain("•");
  });
});

describe("digestKeyboard", () => {
  it("callback dig:<mode> + маркер текущего", () => {
    const btns = rows(digestKeyboard("daily"));
    expect(btns.map((b) => b.callback_data)).toEqual(["dig:off", "dig:daily", "dig:shift"]);
    expect(btns.find((b) => b.callback_data === "dig:daily")?.text).toContain("•");
  });
});

describe("topicsKeyboard", () => {
  it("✅/⬜ по карте, callback tpc:<topic>", () => {
    const btns = rows(
      topicsKeyboard({ leads: true, escalation: false, orders: true, system: false }),
    );
    expect(btns.find((b) => b.callback_data === "tpc:leads")?.text).toContain("✅");
    expect(btns.find((b) => b.callback_data === "tpc:escalation")?.text).toContain("⬜");
  });
});

describe("topicMap", () => {
  it("null → все темы true (дефолт)", () => {
    expect(topicMap(null)).toEqual({ leads: true, escalation: true, orders: true, system: true });
  });
  it("выключает только явные false, остальные true", () => {
    expect(topicMap('{"orders":false,"leads":false}')).toEqual({
      leads: false,
      escalation: true,
      orders: false,
      system: true,
    });
  });
  it("битый JSON → дефолт", () => {
    expect(topicMap("{broken")).toEqual({
      leads: true,
      escalation: true,
      orders: true,
      system: true,
    });
  });
});
