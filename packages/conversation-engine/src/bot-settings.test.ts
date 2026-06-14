import { describe, expect, it } from "bun:test";
import {
  DEFAULT_BOT_SETTINGS,
  isWithinBotHours,
  matchStopWord,
  mergeBotSettings,
  parseBotSettings,
} from "./bot-settings.ts";

describe("parseBotSettings", () => {
  it("null/битый JSON → дефолты", () => {
    expect(parseBotSettings(null)).toEqual(DEFAULT_BOT_SETTINGS);
    expect(parseBotSettings("not json")).toEqual(DEFAULT_BOT_SETTINGS);
    expect(parseBotSettings("[]")).toEqual(DEFAULT_BOT_SETTINGS);
  });

  it("клампит числа в допустимые диапазоны", () => {
    const s = parseBotSettings(
      JSON.stringify({ temperature: 5, maxOutputTokens: 999999, compactAfterMessages: 1, autocloseHours: 9999 }),
    );
    expect(s.temperature).toBe(1.5);
    expect(s.maxOutputTokens).toBe(4000);
    expect(s.compactAfterMessages).toBe(5);
    expect(s.autocloseHours).toBe(720);
  });

  it("нормализует стоп-слова: строка/массив → уник, lowercase, без пустых", () => {
    expect(parseBotSettings(JSON.stringify({ stopWords: "Оператор, человек\nЖАЛОБА, " })).stopWords).toEqual([
      "оператор",
      "человек",
      "жалоба",
    ]);
    expect(parseBotSettings(JSON.stringify({ stopWords: ["A", "a", " b "] })).stopWords).toEqual(["a", "b"]);
  });

  it("voiceStt по умолчанию true; пустые строки → null", () => {
    expect(parseBotSettings("{}").voiceStt).toBe(true);
    expect(parseBotSettings(JSON.stringify({ voiceStt: false })).voiceStt).toBe(false);
    expect(parseBotSettings(JSON.stringify({ greetingText: "   " })).greetingText).toBeNull();
  });
});

describe("mergeBotSettings", () => {
  it("патч поверх текущих, нормализуя", () => {
    const cur = parseBotSettings(JSON.stringify({ greetingText: "hi", voiceStt: true }));
    const next = mergeBotSettings(cur, { voiceStt: false, autocloseHours: 48 });
    expect(next.greetingText).toBe("hi"); // не затёрто
    expect(next.voiceStt).toBe(false);
    expect(next.autocloseHours).toBe(48);
  });
});

describe("isWithinBotHours", () => {
  // 2021-06-15T09:30:00Z = 09:30 UTC.
  const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

  it("часы выкл → всегда true", () => {
    expect(isWithinBotHours(DEFAULT_BOT_SETTINGS, at("2021-06-15T03:00:00Z"))).toBe(true);
  });

  it("обычное окно [09:00,18:00) UTC", () => {
    const s = parseBotSettings(
      JSON.stringify({ hoursEnabled: true, hoursStartMin: 540, hoursEndMin: 1080, hoursTz: "UTC" }),
    );
    expect(isWithinBotHours(s, at("2021-06-15T09:30:00Z"))).toBe(true);
    expect(isWithinBotHours(s, at("2021-06-15T18:00:00Z"))).toBe(false);
    expect(isWithinBotHours(s, at("2021-06-15T08:59:00Z"))).toBe(false);
  });

  it("окно через полночь [22:00,06:00)", () => {
    const s = parseBotSettings(
      JSON.stringify({ hoursEnabled: true, hoursStartMin: 1320, hoursEndMin: 360, hoursTz: "UTC" }),
    );
    expect(isWithinBotHours(s, at("2021-06-15T23:00:00Z"))).toBe(true);
    expect(isWithinBotHours(s, at("2021-06-15T05:00:00Z"))).toBe(true);
    expect(isWithinBotHours(s, at("2021-06-15T12:00:00Z"))).toBe(false);
  });

  it("невалидная таймзона → fail-open (true)", () => {
    const s = parseBotSettings(
      JSON.stringify({ hoursEnabled: true, hoursStartMin: 540, hoursEndMin: 1080, hoursTz: "Nope/Nope" }),
    );
    expect(isWithinBotHours(s, at("2021-06-15T03:00:00Z"))).toBe(true);
  });
});

describe("matchStopWord", () => {
  const s = parseBotSettings(JSON.stringify({ stopWords: ["оператор", "жалоба"] }));
  it("находит подстроку регистронезависимо", () => {
    expect(matchStopWord(s, "позовите ОПЕРАТОРА пожалуйста")).toBe("оператор");
    expect(matchStopWord(s, "хочу обмен")).toBeNull();
  });
  it("нет стоп-слов → null", () => {
    expect(matchStopWord(DEFAULT_BOT_SETTINGS, "оператор")).toBeNull();
  });
});
