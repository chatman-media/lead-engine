import { describe, expect, it } from "bun:test";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { needsTranslation, OPERATOR_LANG, translateText } from "./translation.ts";

function fakeChat(impl: (messages: ChatMessage[]) => string | Promise<string>): {
  chat: ChatClient;
  calls: () => number;
} {
  let calls = 0;
  const chat = {
    async complete(messages: ChatMessage[]) {
      calls++;
      return impl(messages);
    },
  } as unknown as ChatClient;
  return { chat, calls: () => calls };
}

describe("needsTranslation", () => {
  it("равные языки (в т.ч. оба ru) → не переводим", () => {
    expect(needsTranslation("ru", "ru")).toBe(false);
    expect(needsTranslation("en", "en")).toBe(false);
  });
  it("разные языки → переводим", () => {
    expect(needsTranslation("en", "ru")).toBe(true);
    expect(needsTranslation("ru", "ko")).toBe(true);
  });
  it("OPERATOR_LANG = ru", () => {
    expect(OPERATOR_LANG).toBe("ru");
  });
});

describe("translateText", () => {
  it("переводит непустой текст и возвращает результат модели", async () => {
    const f = fakeChat(() => "Здравствуйте");
    const out = await translateText({ chat: f.chat, text: "Hello", targetLang: "ru" });
    expect(out).toBe("Здравствуйте");
    expect(f.calls()).toBe(1);
  });

  it("пустой/пробельный/медиа-only текст → возвращает как есть, без вызова LLM", async () => {
    const f = fakeChat(() => "X");
    expect(await translateText({ chat: f.chat, text: "", targetLang: "ru" })).toBe("");
    expect(await translateText({ chat: f.chat, text: "   ", targetLang: "ru" })).toBe("   ");
    expect(f.calls()).toBe(0);
  });

  it("пустой ответ модели → fallback на оригинал", async () => {
    const f = fakeChat(() => "  ");
    const out = await translateText({ chat: f.chat, text: "Hello", targetLang: "ru" });
    expect(out).toBe("Hello");
  });

  it("ошибка LLM → возвращает оригинал и зовёт onWarn (не роняет флоу)", async () => {
    const f = fakeChat(() => {
      throw new Error("llm down");
    });
    let warned = "";
    const out = await translateText({
      chat: f.chat,
      text: "Hello",
      targetLang: "ru",
      onWarn: (m: string) => {
        warned = m;
      },
    });
    expect(out).toBe("Hello");
    expect(warned).toContain("translation");
  });

  it("системный промпт несёт целевой язык и правило «только перевод»", async () => {
    let sys = "";
    const f = fakeChat((messages) => {
      sys = String(messages[0]?.content ?? "");
      return "번역됨";
    });
    await translateText({ chat: f.chat, text: "привет", targetLang: "ko" });
    expect(sys).toContain("한국어");
    expect(sys.toLowerCase()).toContain("only the translation");
  });
});
