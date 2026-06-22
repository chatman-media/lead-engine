// Unit (без PG) для translateOperatorReply. db.transaction отдаёт detected_lang;
// resolveChat → фейк ChatClient. Перевод мокаем через возвращаемый текст.

import { describe, expect, it } from "bun:test";
import type { ChatClient } from "@chatman-media/llm-router";
import type { Db } from "./dal/types.ts";
import type { PendingOperatorDraft } from "./operator-bot-shared.ts";
import { translateOperatorReply } from "./operator-reply-translation.ts";

function dbWithLang(lang: string | null): Db {
  const node: Record<string, unknown> = {
    execute: async () => undefined,
    select: () => node,
    from: () => node,
    where: () => node,
    limit: async () => (lang === null ? [] : [{ detectedLang: lang }]),
  };
  return { transaction: async (cb: (t: unknown) => unknown) => cb(node) } as unknown as Db;
}

const chat = (out: string): ChatClient => ({ complete: async () => out }) as unknown as ChatClient;
const resolveChat = (out: string) => () => chat(out);

const draft = (over: Partial<PendingOperatorDraft> = {}): PendingOperatorDraft => ({
  draftId: "d1",
  tenantId: 1,
  adminId: 2,
  chatId: "100",
  conversationId: 5,
  text: "Привет, как дела?",
  metadata: {},
  createdAt: 0,
  expiresAt: 0,
  ...over,
});

describe("translateOperatorReply", () => {
  it("нет resolveChat → null", async () => {
    expect(await translateOperatorReply(undefined, draft(), dbWithLang("en"))).toBeNull();
  });

  it("exchangeAction в metadata → перевод выключен (null)", async () => {
    const r = await translateOperatorReply(
      resolveChat("hi"),
      draft({ metadata: { exchangeAction: "payout_ready" } }),
      dbWithLang("en"),
    );
    expect(r).toBeNull();
  });

  it("пустой текст → null", async () => {
    expect(
      await translateOperatorReply(resolveChat("x"), draft({ text: "   " }), dbWithLang("en")),
    ).toBeNull();
  });

  it("язык клиента = язык оператора (ru) → перевод не нужен", async () => {
    expect(await translateOperatorReply(resolveChat("x"), draft(), dbWithLang("ru"))).toBeNull();
  });

  it("detected_lang отсутствует → null", async () => {
    expect(await translateOperatorReply(resolveChat("x"), draft(), dbWithLang(null))).toBeNull();
  });

  it("клиент на en → переводит и возвращает {text, lang}", async () => {
    const r = await translateOperatorReply(
      resolveChat("Hello, how are you?"),
      draft(),
      dbWithLang("en"),
    );
    expect(r).toEqual({ text: "Hello, how are you?", lang: "en" });
  });

  it("перевод совпал с оригиналом → null (нечего слать)", async () => {
    const original = "Привет, как дела?";
    const r = await translateOperatorReply(
      resolveChat(original),
      draft({ text: original }),
      dbWithLang("en"),
    );
    expect(r).toBeNull();
  });
});
