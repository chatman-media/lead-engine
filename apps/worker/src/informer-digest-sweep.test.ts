import type { AdminNotificationRow } from "@chatman-media/conversation-engine";
import { describe, expect, it } from "bun:test";
import { isDigestDue, renderDigest } from "./informer-digest-sweep.ts";

const ep = (h: number, day = 5) => Math.floor(Date.UTC(2026, 5, day, h, 0, 0) / 1000); // июнь

function s(over: Partial<Parameters<typeof isDigestDue>[0]> = {}) {
  return {
    informerDigest: "daily",
    informerDigestHour: 9,
    informerTz: "UTC",
    informerLastDigestAt: null as number | null,
    ...over,
  };
}

describe("isDigestDue (daily)", () => {
  it("off → никогда", () => {
    expect(isDigestDue(s({ informerDigest: "off" }), ep(12))).toBe(false);
  });
  it("час достигнут, ещё не слали сегодня → due", () => {
    expect(isDigestDue(s(), ep(10))).toBe(true);
  });
  it("до digest-часа → not due", () => {
    expect(isDigestDue(s(), ep(8))).toBe(false);
  });
  it("уже слали сегодня → not due", () => {
    expect(isDigestDue(s({ informerLastDigestAt: ep(9) }), ep(12))).toBe(false);
  });
  it("слали вчера → due на следующий день", () => {
    expect(isDigestDue(s({ informerLastDigestAt: ep(9, 4) }), ep(10, 5))).toBe(true);
  });
});

describe("isDigestDue (shift)", () => {
  const sh = (over = {}) => s({ informerDigest: "shift", informerDigestHour: 9, ...over });
  it("первый слот (09) → due", () => {
    expect(isDigestDue(sh(), ep(10))).toBe(true);
  });
  it("второй слот (21) после утреннего → due снова", () => {
    expect(isDigestDue(sh({ informerLastDigestAt: ep(10) }), ep(22))).toBe(true);
  });
  it("тот же слот повторно → not due", () => {
    expect(isDigestDue(sh({ informerLastDigestAt: ep(10) }), ep(12))).toBe(false);
  });
});

describe("renderDigest", () => {
  const row = (over: Partial<AdminNotificationRow>): AdminNotificationRow =>
    ({ topic: "leads", severity: "info", title: "t", body: "", ...over }) as AdminNotificationRow;

  it("группирует по теме и считает", () => {
    const html = renderDigest(
      [row({ topic: "leads" }), row({ topic: "leads" }), row({ topic: "orders" })],
      0,
    );
    expect(html).toContain("накопилось 3");
    expect(html).toContain("🆕 Лиды: 2");
    expect(html).toContain("💱 Заявки: 1");
  });

  it("выносит важное и показывает счётчик эскалаций", () => {
    const html = renderDigest(
      [row({ severity: "critical", title: "Канал упал", topic: "system" })],
      4,
    );
    expect(html).toContain("Важное:");
    expect(html).toContain("Канал упал");
    expect(html).toContain("ждут оператора: <b>4</b>");
  });
});
