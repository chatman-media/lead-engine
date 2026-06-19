import { describe, expect, it } from "bun:test";
import {
  asSupportedLang,
  DEFAULT_LANG,
  detectScriptLang,
  effectiveLang,
  mapChannelLangHint,
  resolveConversationLang,
  SUPPORTED_LANGS,
} from "./language.ts";

describe("detectScriptLang", () => {
  it("уверенно определяет русский по кириллице", () => {
    const r = detectScriptLang("Привет, сколько стоит обмен?");
    expect(r.lang).toBe("ru");
    expect(r.confident).toBe(true);
  });

  it("уверенно определяет английский по латинице", () => {
    const r = detectScriptLang("Hello, how much for the exchange?");
    expect(r.lang).toBe("en");
    expect(r.confident).toBe(true);
  });

  it("уверенно определяет корейский по хангыль", () => {
    const r = detectScriptLang("안녕하세요 환전 부탁드립니다");
    expect(r.lang).toBe("ko");
    expect(r.confident).toBe(true);
  });

  it("уверенно определяет китайский по ханьцзы", () => {
    const r = detectScriptLang("您好我想换钱");
    expect(r.lang).toBe("zh");
    expect(r.confident).toBe(true);
  });

  it("коротко «ok» — не confident (≤ MIN_LATIN_CYRILLIC_CHARS)", () => {
    const r = detectScriptLang("ok");
    expect(r.confident).toBe(false);
    expect(r.lang).toBeNull();
  });

  it("коротко «да» — не confident", () => {
    const r = detectScriptLang("да");
    expect(r.confident).toBe(false);
  });

  it("только цифры — не confident", () => {
    const r = detectScriptLang("5000");
    expect(r.confident).toBe(false);
    expect(r.lang).toBeNull();
  });

  it("эмодзи — не confident", () => {
    const r = detectScriptLang("👍👍👍");
    expect(r.confident).toBe(false);
    expect(r.lang).toBeNull();
  });

  it("пустая строка — не confident", () => {
    expect(detectScriptLang("").confident).toBe(false);
    expect(detectScriptLang("   ").confident).toBe(false);
  });

  it("смешанный текст: доминирует кириллица — ru confident", () => {
    const r = detectScriptLang("Привет, нужен USDT срочно");
    expect(r.lang).toBe("ru");
    expect(r.confident).toBe(true);
  });

  it("смешанный 50/50 ru/en — не confident (доля каждого <0.7)", () => {
    const r = detectScriptLang("Привет hello there спасибо");
    // Доля латиницы ≈ 11, кириллицы ≈ 12 — оба <0.7.
    expect(r.confident).toBe(false);
  });

  it("CJK порог ниже — 2 китайских символа уже confident", () => {
    const r = detectScriptLang("你好");
    expect(r.lang).toBe("zh");
    expect(r.confident).toBe(true);
  });
});

describe("mapChannelLangHint", () => {
  it("маппит простые коды в набор", () => {
    expect(mapChannelLangHint("ru")).toBe("ru");
    expect(mapChannelLangHint("en")).toBe("en");
    expect(mapChannelLangHint("ko")).toBe("ko");
    expect(mapChannelLangHint("zh")).toBe("zh");
  });

  it("отрезает регион/локаль", () => {
    expect(mapChannelLangHint("en-US")).toBe("en");
    expect(mapChannelLangHint("zh_TW")).toBe("zh");
    expect(mapChannelLangHint("RU-ru")).toBe("ru");
  });

  it("неизвестный → null", () => {
    expect(mapChannelLangHint("ja")).toBeNull();
    expect(mapChannelLangHint("fr-FR")).toBeNull();
  });

  it("пустое/мусор → null", () => {
    expect(mapChannelLangHint("")).toBeNull();
    expect(mapChannelLangHint("   ")).toBeNull();
    expect(mapChannelLangHint(null)).toBeNull();
    expect(mapChannelLangHint(undefined)).toBeNull();
  });
});

describe("resolveConversationLang — стабилизация и залипание", () => {
  it("current=null + confident → ставим и locked", () => {
    const r = resolveConversationLang({
      current: null,
      locked: false,
      detected: { lang: "ru", confident: true },
      channelHint: null,
      isFirstMessage: true,
    });
    expect(r).toEqual({ lang: "ru", locked: true, changed: true });
  });

  it("current=null + не-confident + hint + первое → ставим hint мягко", () => {
    const r = resolveConversationLang({
      current: null,
      locked: false,
      detected: { lang: null, confident: false },
      channelHint: "en",
      isFirstMessage: true,
    });
    expect(r).toEqual({ lang: "en", locked: false, changed: true });
  });

  it("locked + неуверенный сигнал → не меняем (залипание)", () => {
    const r = resolveConversationLang({
      current: "ru",
      locked: true,
      detected: { lang: null, confident: false },
      channelHint: "en",
      isFirstMessage: false,
    });
    expect(r).toEqual({ lang: "ru", locked: true, changed: false });
  });

  it("locked + confident ДРУГОГО языка → меняем (осознанная смена)", () => {
    const r = resolveConversationLang({
      current: "ru",
      locked: true,
      detected: { lang: "en", confident: true },
      channelHint: null,
      isFirstMessage: false,
    });
    expect(r).toEqual({ lang: "en", locked: true, changed: true });
  });

  it("locked + confident ТОГО ЖЕ языка → no-op", () => {
    const r = resolveConversationLang({
      current: "ru",
      locked: true,
      detected: { lang: "ru", confident: true },
      channelHint: null,
      isFirstMessage: false,
    });
    expect(r.lang).toBe("ru");
    expect(r.changed).toBe(false);
  });

  it("не первое сообщение + current=null + hint → ставим hint (bootstrap не сработал раньше)", () => {
    // Кейс: первое сообщение было media-only без hint в адаптере, второе тоже media-only,
    // но hint уже пришёл. isFirstMessage=false — hint не перебивает залипание, но current=null.
    // Согласно правилам hint срабатывает только при isFirstMessage=true → not changed.
    const r = resolveConversationLang({
      current: null,
      locked: false,
      detected: { lang: null, confident: false },
      channelHint: "en",
      isFirstMessage: false,
    });
    expect(r.changed).toBe(false);
    expect(r.lang).toBeNull();
  });

  it("не-locked + confident → ставим и locked", () => {
    const r = resolveConversationLang({
      current: "en",
      locked: false,
      detected: { lang: "ru", confident: true },
      channelHint: null,
      isFirstMessage: false,
    });
    expect(r).toEqual({ lang: "ru", locked: true, changed: true });
  });
});

describe("effectiveLang — каскад фолбэков", () => {
  it("есть detectedLang → берём его", () => {
    expect(effectiveLang({ detectedLang: "ru", tenantDefaultLang: "en" })).toBe("ru");
  });

  it("нет detectedLang → тенант-дефолт", () => {
    expect(effectiveLang({ detectedLang: null, tenantDefaultLang: "ko" })).toBe("ko");
  });

  it("ничего нет → DEFAULT_LANG", () => {
    expect(effectiveLang({ detectedLang: null, tenantDefaultLang: null })).toBe(DEFAULT_LANG);
    expect(effectiveLang({ detectedLang: undefined })).toBe(DEFAULT_LANG);
  });

  it("невалидный detectedLang → фолбэк дальше по каскаду", () => {
    expect(effectiveLang({ detectedLang: "xx", tenantDefaultLang: "ru" })).toBe("ru");
  });
});

describe("asSupportedLang", () => {
  it("принимает все поддерживаемые", () => {
    for (const l of SUPPORTED_LANGS) {
      expect(asSupportedLang(l)).toBe(l);
    }
  });

  it("регистронезависимый", () => {
    expect(asSupportedLang("RU")).toBe("ru");
    expect(asSupportedLang(" En ")).toBe("en");
  });

  it("неподдерживаемое → null", () => {
    expect(asSupportedLang("ja")).toBeNull();
    expect(asSupportedLang("")).toBeNull();
    expect(asSupportedLang(null)).toBeNull();
    expect(asSupportedLang(123)).toBeNull();
  });
});
