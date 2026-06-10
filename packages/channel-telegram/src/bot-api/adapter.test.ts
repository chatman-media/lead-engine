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

  it("rawClient отдаёт нижележащий TelegramClient", () => {
    const { fetch } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    expect(adapter.rawClient).toBeDefined();
    expect(typeof adapter.rawClient.getMe).toBe("function");
  });

  it("send: пустые parts → throws", async () => {
    const { fetch } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await expect(
      adapter.send({ channelId: "tg1", externalUserId: "1", parts: [] }),
    ).rejects.toThrow(/non-empty/);
  });

  it("send: нечисловой externalUserId → throws", async () => {
    const { fetch } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await expect(
      adapter.send({
        channelId: "tg1",
        externalUserId: "not-a-number",
        parts: [{ kind: "text", text: "x" }],
      }),
    ).rejects.toThrow(/invalid externalUserId/);
  });

  it("send photo/video/document parts → sendPhoto/sendVideo/sendDocument с caption", async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await adapter.send({
      channelId: "tg1",
      externalUserId: "5",
      parts: [
        { kind: "photo", mediaRef: { channelId: "tg1", externalRef: "PH" }, caption: "pic" },
        { kind: "video", mediaRef: { channelId: "tg1", externalRef: "VID" }, caption: "vid" },
        { kind: "document", mediaRef: { channelId: "tg1", externalRef: "DOC" }, caption: "doc" },
      ],
    });
    expect(calls.map((c) => c.url.split("/").pop())).toEqual([
      "sendPhoto",
      "sendVideo",
      "sendDocument",
    ]);
    expect(calls[0]?.body).toEqual({ chat_id: 5, photo: "PH", caption: "pic" });
    expect(calls[1]?.body).toEqual({ chat_id: 5, video: "VID", caption: "vid" });
    expect(calls[2]?.body).toEqual({ chat_id: 5, document: "DOC", caption: "doc" });
  });

  it("send media-parts без caption → нет caption в body", async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await adapter.send({
      channelId: "tg1",
      externalUserId: "5",
      parts: [{ kind: "photo", mediaRef: { channelId: "tg1", externalRef: "PH" } }],
    });
    expect(calls[0]?.body).toEqual({ chat_id: 5, photo: "PH" });
  });

  it("send: parseMode markdown→MarkdownV2, html→HTML", async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await adapter.send({
      channelId: "tg1",
      externalUserId: "5",
      parts: [
        { kind: "text", text: "md", parseMode: "markdown" },
        { kind: "text", text: "ht", parseMode: "html" },
      ],
    });
    expect(calls[0]?.body).toMatchObject({ parse_mode: "MarkdownV2" });
    expect(calls[1]?.body).toMatchObject({ parse_mode: "HTML" });
  });

  it("send: replyToExternalMessageId уходит как reply_to_message_id только на первой части", async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await adapter.send({
      channelId: "tg1",
      externalUserId: "5",
      parts: [
        { kind: "text", text: "one" },
        { kind: "text", text: "two" },
      ],
      replyToExternalMessageId: "77",
    });
    expect(calls[0]?.body).toMatchObject({ reply_to_message_id: 77 });
    expect(calls[1]?.body).not.toHaveProperty("reply_to_message_id");
  });

  it("edit: маппит в editMessageText с parse_mode и reply_markup", async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await adapter.edit({
      channelId: "tg1",
      externalUserId: "10",
      externalMessageId: "20",
      text: "edited",
      parseMode: "html",
      replyMarkup: { inlineButtons: [[{ label: "Ok", callbackData: "ok" }]] },
    });
    expect(calls[0]?.url).toBe("https://api.telegram.org/botTKN/editMessageText");
    expect(calls[0]?.body).toEqual({
      chat_id: 10,
      message_id: 20,
      text: "edited",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Ok", callback_data: "ok" }]] },
    });
  });

  it("edit: нечисловые id → throws", async () => {
    const { fetch } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await expect(
      adapter.edit({
        channelId: "tg1",
        externalUserId: "abc",
        externalMessageId: "20",
        text: "x",
      }),
    ).rejects.toThrow(/edit requires numeric/);
  });

  it("delete: маппит в deleteMessage; нечисловые id → throws", async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await adapter.delete({ channelId: "tg1", externalUserId: "10", externalMessageId: "20" });
    expect(calls[0]?.url).toBe("https://api.telegram.org/botTKN/deleteMessage");
    expect(calls[0]?.body).toEqual({ chat_id: 10, message_id: 20 });
    await expect(
      adapter.delete({ channelId: "tg1", externalUserId: "10", externalMessageId: "nope" }),
    ).rejects.toThrow(/delete requires numeric/);
  });

  it("downloadMedia: getFile → скачивание байтов по file_path", async () => {
    const urls: string[] = [];
    const fn = async (url: string | URL | Request): Promise<Response> => {
      urls.push(String(url));
      if (String(url).endsWith("/getFile")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { file_id: "F", file_unique_id: "U", file_path: "photos/x.jpg" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("BYTES", { status: 200 });
    };
    const adapter = new TelegramBotAdapter({
      id: "tg1",
      token: "TKN",
      fetch: fn as unknown as typeof fetch,
    });
    const res = await adapter.downloadMedia({ channelId: "tg1", externalRef: "F" });
    expect(await res.text()).toBe("BYTES");
    expect(urls[0]).toBe("https://api.telegram.org/botTKN/getFile");
    expect(urls[1]).toBe("https://api.telegram.org/file/botTKN/photos/x.jpg");
  });

  it("signalTyping: валидный id → sendChatAction; NaN → no-op", async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    await adapter.signalTyping("42");
    expect(calls[0]?.url).toBe("https://api.telegram.org/botTKN/sendChatAction");
    expect(calls[0]?.body).toEqual({ chat_id: 42, action: "typing" });
    await adapter.signalTyping("not-a-number");
    expect(calls).toHaveLength(1); // второй вызов не дошёл до API
  });

  it("pushUpdate с нерелевантным update → silent drop", async () => {
    const { fetch } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    adapter.pushUpdate({ update_id: 99 });
    const iter = adapter.receive()[Symbol.asyncIterator]();
    const pending = iter.next();
    adapter.close();
    expect((await pending).done).toBe(true);
  });

  it("receive: уже aborted signal → done сразу", async () => {
    const { fetch } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    const ctrl = new AbortController();
    ctrl.abort();
    const iter = adapter.receive(ctrl.signal)[Symbol.asyncIterator]();
    expect((await iter.next()).done).toBe(true);
  });

  it("receive: abort во время ожидания → done и waiter убран", async () => {
    const { fetch } = fakeFetch();
    const adapter = new TelegramBotAdapter({ id: "tg1", token: "TKN", fetch });
    const ctrl = new AbortController();
    const iter = adapter.receive(ctrl.signal)[Symbol.asyncIterator]();
    const pending = iter.next();
    ctrl.abort();
    expect((await pending).done).toBe(true);
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
