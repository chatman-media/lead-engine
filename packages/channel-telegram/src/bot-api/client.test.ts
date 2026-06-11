import { describe, expect, it } from "bun:test";
import { TelegramApiError, TelegramClient } from "./client.ts";
import type { FetchLike } from "./client.ts";

function envelope(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}
function mock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as FetchLike;
  return { fn, calls };
}
const client = (fetch: FetchLike) => new TelegramClient({ token: "T", fetch });
const bodyOf = (init?: RequestInit) => JSON.parse(init?.body as string);

describe("TelegramClient constructor", () => {
  it("требует token", () => {
    expect(() => new TelegramClient({ token: "" })).toThrow("token is required");
  });
});

describe("TelegramClient методы", () => {
  it("getMe", async () => {
    const { fn, calls } = mock(() => envelope({ id: 1, is_bot: true }));
    expect((await client(fn).getMe()).id).toBe(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/botT/getMe");
  });

  it("sendMessage — параметры и результат", async () => {
    const { fn, calls } = mock(() => envelope({ message_id: 9 }));
    const r = await client(fn).sendMessage({
      chatId: "100",
      text: "hi",
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [[{ text: "x", callback_data: "y" }]] },
      disableWebPagePreview: true,
      replyToMessageId: 5,
    });
    expect(r.message_id).toBe(9);
    const b = bodyOf(calls[0]!.init);
    expect(b).toMatchObject({ chat_id: "100", text: "hi", parse_mode: "HTML", disable_web_page_preview: true, reply_to_message_id: 5 });
    expect(b.reply_markup.inline_keyboard).toBeDefined();
  });

  it("sendPhoto / sendVideo / sendDocument", async () => {
    const { fn, calls } = mock(() => envelope({ message_id: 1 }));
    const c = client(fn);
    await c.sendPhoto({ chatId: 1, photoFileId: "p", caption: "c" });
    await c.sendVideo({ chatId: 1, videoFileId: "v" });
    await c.sendVideoNote({ chatId: 1, videoNoteFileId: "vn" });
    await c.sendDocument({ chatId: 1, documentFileId: "d", caption: "cap" });
    expect(calls[0]!.url).toContain("/sendPhoto");
    expect(bodyOf(calls[0]!.init).photo).toBe("p");
    expect(calls[1]!.url).toContain("/sendVideo");
    expect(calls[2]!.url).toContain("/sendVideoNote");
    expect(bodyOf(calls[2]!.init).video_note).toBe("vn");
    expect(bodyOf(calls[3]!.init).document).toBe("d");
  });

  it("send media upload methods use multipart form data", async () => {
    const { fn, calls } = mock(() => envelope({ message_id: 1 }));
    const c = client(fn);
    await c.sendPhotoUpload({
      chatId: "ops",
      bytes: new TextEncoder().encode("IMG"),
      filename: "kyc.jpg",
      contentType: "image/jpeg",
      caption: "passport",
    });
    await c.sendVideoUpload({
      chatId: "ops",
      bytes: new TextEncoder().encode("VID"),
      filename: "kyc.mp4",
      contentType: "video/mp4",
    });
    await c.sendVideoNoteUpload({
      chatId: "ops",
      bytes: new TextEncoder().encode("CIRCLE"),
      filename: "circle.mp4",
      contentType: "video/mp4",
    });
    await c.sendDocumentUpload({
      chatId: "ops",
      bytes: new TextEncoder().encode("DOC"),
      filename: "statement.pdf",
      contentType: "application/pdf",
    });

    const photoForm = calls[0]!.init!.body as FormData;
    expect(calls[0]!.url).toContain("/sendPhoto");
    expect(photoForm.get("chat_id")).toBe("ops");
    expect(photoForm.get("caption")).toBe("passport");
    const photo = photoForm.get("photo") as File;
    expect(photo.name).toBe("kyc.jpg");
    expect(photo.type).toBe("image/jpeg");
    expect(await photo.text()).toBe("IMG");

    expect(calls[1]!.url).toContain("/sendVideo");
    expect((calls[1]!.init!.body as FormData).get("video")).toBeInstanceOf(File);
    expect(calls[2]!.url).toContain("/sendVideoNote");
    expect((calls[2]!.init!.body as FormData).get("video_note")).toBeInstanceOf(File);
    expect(calls[3]!.url).toContain("/sendDocument");
    expect((calls[3]!.init!.body as FormData).get("document")).toBeInstanceOf(File);
  });

  it("sendLocalVideo — не поддержано (throws)", () => {
    expect(() => client(mock(() => envelope({})).fn).sendLocalVideo({ chatId: 1, localFilePath: "/x" })).toThrow();
  });

  it("editMessageText / deleteMessage", async () => {
    const { fn, calls } = mock((url) => (url.includes("delete") ? envelope(true) : envelope({ message_id: 2 })));
    const c = client(fn);
    await c.editMessageText({ chatId: 1, messageId: 2, text: "new", parseMode: "HTML", replyMarkup: {} });
    expect(await c.deleteMessage({ chatId: 1, messageId: 2 })).toBe(true);
    expect(bodyOf(calls[0]!.init)).toMatchObject({ message_id: 2, text: "new" });
  });

  it("answerCallbackQuery — text + show_alert", async () => {
    const { fn, calls } = mock(() => envelope(true));
    await client(fn).answerCallbackQuery({ callbackQueryId: "cb", text: "ok", showAlert: true });
    expect(bodyOf(calls[0]!.init)).toMatchObject({ callback_query_id: "cb", text: "ok", show_alert: true });
  });

  it("answerCallbackQuery — url", async () => {
    const { fn, calls } = mock(() => envelope(true));
    await client(fn).answerCallbackQuery({ callbackQueryId: "cb", url: "https://app.test/conversations/7" });
    expect(bodyOf(calls[0]!.init)).toMatchObject({
      callback_query_id: "cb",
      url: "https://app.test/conversations/7",
    });
  });

  it("sendChatAction", async () => {
    const { fn, calls } = mock(() => envelope(true));
    await client(fn).sendChatAction({ chatId: 1, action: "typing" });
    expect(bodyOf(calls[0]!.init).action).toBe("typing");
  });

  it("setWebhook / deleteWebhook / getWebhookInfo", async () => {
    const { fn, calls } = mock((url) =>
      url.includes("getWebhookInfo") ? envelope({ url: "u", pending_update_count: 0 }) : envelope(true),
    );
    const c = client(fn);
    await c.setWebhook({ url: "https://x", secretToken: "s", allowedUpdates: ["message"], dropPendingUpdates: true });
    await c.deleteWebhook(true);
    expect((await c.getWebhookInfo()).url).toBe("u");
    expect(bodyOf(calls[0]!.init)).toMatchObject({ url: "https://x", secret_token: "s", drop_pending_updates: true });
  });

  it("getFile + downloadFile (two-step)", async () => {
    const { fn } = mock((url) => (url.includes("/getFile") ? envelope({ file_path: "photos/a.jpg" }) : new Response("BYTES")));
    const res = await client(fn).downloadFile("fid");
    expect(await res.text()).toBe("BYTES");
  });

  it("downloadFile без file_path → throws", async () => {
    const { fn } = mock(() => envelope({ file_id: "f" }));
    await expect(client(fn).downloadFile("fid")).rejects.toThrow("no file_path");
  });
});

describe("TelegramClient.call error-ветки", () => {
  it("HTTP !ok → TelegramApiError", async () => {
    const { fn } = mock(() => new Response(JSON.stringify({ ok: false, error_code: 401, description: "bad" }), { status: 401 }));
    await expect(client(fn).getMe()).rejects.toBeInstanceOf(TelegramApiError);
  });
  it("body.ok=false → TelegramApiError с описанием", async () => {
    const { fn } = mock(() => new Response(JSON.stringify({ ok: false, description: "nope" }), { status: 200 }));
    await expect(client(fn).getMe()).rejects.toThrow("nope");
  });
  it("non-JSON → TelegramApiError", async () => {
    const { fn } = mock(() => new Response("<html>", { status: 200 }));
    await expect(client(fn).getMe()).rejects.toBeInstanceOf(TelegramApiError);
  });
});
