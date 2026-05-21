import { describe, expect, it } from "bun:test";
import { TelegramBotAdapter } from "./adapter.ts";
import type { TgUpdate } from "./types.ts";

interface RecordedCall {
  url: string;
  body: unknown;
}

function fakeFetch(): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1234 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe("TelegramBotAdapter", () => {
  it("маппит OutboundEnvelope c text-part в sendMessage с chat_id/text", async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    const sent = await adapter.send({
      channelId: "tg1",
      externalUserId: "12345",
      parts: [{ kind: "text", text: "hello" }],
    });
    expect(sent.externalMessageId).toBe("1234");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.telegram.org/botTKN/sendMessage");
    expect(call?.body).toEqual({ chat_id: 12345, text: "hello" });
  });

  it("маппит inline-кнопки на reply_markup, и кладёт их только на последнее сообщение", async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await adapter.send({
      channelId: "tg1",
      externalUserId: "10",
      parts: [
        { kind: "text", text: "one" },
        { kind: "text", text: "two" },
      ],
      replyMarkup: { inlineButtons: [[{ label: "Yes", callbackData: "y" }]] },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).not.toHaveProperty("reply_markup");
    expect(calls[1]?.body).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "y" }]] },
    });
  });

  it("receive() возвращает Inbound из pushUpdate без race conditions", async () => {
    const { fetch } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    const update: TgUpdate = {
      update_id: 1,
      message: {
        message_id: 9,
        chat: { id: 7, type: "private" },
        from: { id: 7, username: "kate" },
        date: 1700000000,
        text: "ping",
      },
    };
    // Push до начала чтения — Inbound должен лежать в inbox.
    adapter.pushUpdate(update);
    const iter = adapter.receive()[Symbol.asyncIterator]();
    const next = await iter.next();
    expect(next.done).toBe(false);
    expect(next.value.parts).toEqual([{ kind: "text", text: "ping" }]);

    // Закрываем стрим — receive завершается.
    adapter.close();
    const last = await iter.next();
    expect(last.done).toBe(true);
  });

  it("receive() ждёт pushUpdate если очередь пуста (resolver-pattern)", async () => {
    const { fetch } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    const iter = adapter.receive()[Symbol.asyncIterator]();
    const nextPromise = iter.next();
    // Через микротик пушим update — Promise должен разрешиться.
    queueMicrotask(() => {
      adapter.pushUpdate({
        update_id: 2,
        message: {
          message_id: 1,
          chat: { id: 1, type: "private" },
          from: { id: 1 },
          date: 0,
          text: "async",
        },
      });
    });
    const next = await nextPromise;
    expect(next.value.parts).toEqual([{ kind: "text", text: "async" }]);
  });
});
