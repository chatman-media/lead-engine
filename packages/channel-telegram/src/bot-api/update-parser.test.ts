import { describe, expect, it } from "bun:test";
import type { TgUpdate } from "./types.ts";
import { parseUpdate } from "./update-parser.ts";

const CH = "telegram-bot-1";

describe("parseUpdate", () => {
  it("парсит текстовое сообщение в одну часть kind=text", () => {
    const update: TgUpdate = {
      update_id: 1,
      message: {
        message_id: 42,
        chat: { id: 100, type: "private" },
        from: { id: 100, first_name: "Alice", username: "alice" },
        date: 1700000000,
        text: "Привет",
      },
    };
    const inbound = parseUpdate(CH, update);
    expect(inbound).not.toBeNull();
    expect(inbound).toMatchObject({
      channelId: CH,
      externalMessageId: "42",
      externalUserId: "100",
      externalUsername: "alice",
      parts: [{ kind: "text", text: "Привет" }],
      receivedAt: 1700000000,
    });
  });

  it("парсит фото с caption, выбирая наибольший size", () => {
    const update: TgUpdate = {
      update_id: 2,
      message: {
        message_id: 7,
        chat: { id: 200, type: "private" },
        from: { id: 200 },
        date: 1700000000,
        caption: "look",
        photo: [
          { file_id: "small", file_unique_id: "u1", width: 90, height: 90 },
          { file_id: "BIG", file_unique_id: "u2", width: 800, height: 800 },
          { file_id: "mid", file_unique_id: "u3", width: 400, height: 400 },
        ],
      },
    };
    const inbound = parseUpdate(CH, update);
    expect(inbound?.parts).toEqual([
      {
        kind: "photo",
        mediaRef: { channelId: CH, externalRef: "BIG" },
        caption: "look",
      },
    ]);
  });

  it("парсит voice как InboundPart с durationSec", () => {
    const update: TgUpdate = {
      update_id: 3,
      message: {
        message_id: 8,
        chat: { id: 300, type: "private" },
        from: { id: 300 },
        date: 1700000000,
        voice: { file_id: "vox", file_unique_id: "vu", duration: 12, mime_type: "audio/ogg" },
      },
    };
    const inbound = parseUpdate(CH, update);
    expect(inbound?.parts).toEqual([
      {
        kind: "voice",
        mediaRef: { channelId: CH, externalRef: "vox" },
        durationSec: 12,
      },
    ]);
  });

  it("парсит document с mimeType и fileName", () => {
    const update: TgUpdate = {
      update_id: 4,
      message: {
        message_id: 9,
        chat: { id: 400, type: "private" },
        from: { id: 400 },
        date: 1700000000,
        document: {
          file_id: "doc1",
          file_unique_id: "du",
          file_name: "passport.pdf",
          mime_type: "application/pdf",
        },
      },
    };
    const inbound = parseUpdate(CH, update);
    expect(inbound?.parts).toEqual([
      {
        kind: "document",
        mediaRef: { channelId: CH, externalRef: "doc1" },
        mimeType: "application/pdf",
        fileName: "passport.pdf",
      },
    ]);
  });

  it("парсит callback_query как kind=callback_query", () => {
    const update: TgUpdate = {
      update_id: 5,
      callback_query: {
        id: "cb-123",
        from: { id: 500, username: "operator" },
        data: "approve:42",
        message: {
          message_id: 999,
          chat: { id: 500, type: "private" },
          date: 1700000000,
        },
      },
    };
    const inbound = parseUpdate(CH, update);
    expect(inbound?.parts).toEqual([
      { kind: "callback_query", data: "approve:42", originalMessageId: "999" },
    ]);
    expect(inbound?.externalUserId).toBe("500");
  });

  it("парсит video с caption", () => {
    const update: TgUpdate = {
      update_id: 10,
      message: {
        message_id: 11,
        chat: { id: 600, type: "private" },
        from: { id: 600 },
        date: 1700000000,
        caption: "watch",
        video: {
          file_id: "vid1",
          file_unique_id: "vu1",
          width: 640,
          height: 480,
          duration: 30,
          mime_type: "video/mp4",
        },
      },
    };
    const inbound = parseUpdate(CH, update);
    expect(inbound?.parts).toEqual([
      {
        kind: "video",
        mediaRef: { channelId: CH, externalRef: "vid1" },
        caption: "watch",
      },
    ]);
  });

  it("парсит video без caption — нет caption-поля", () => {
    const update: TgUpdate = {
      update_id: 11,
      message: {
        message_id: 12,
        chat: { id: 600, type: "private" },
        from: { id: 600 },
        date: 1700000000,
        video: { file_id: "vid2", file_unique_id: "vu2", width: 1, height: 1, duration: 2 },
      },
    };
    expect(parseUpdate(CH, update)?.parts).toEqual([
      { kind: "video", mediaRef: { channelId: CH, externalRef: "vid2" } },
    ]);
  });

  it("парсит video_note («кружок») с durationSec", () => {
    const update: TgUpdate = {
      update_id: 12,
      message: {
        message_id: 13,
        chat: { id: 700, type: "private" },
        from: { id: 700 },
        date: 1700000000,
        video_note: { file_id: "vn1", file_unique_id: "vnu1", length: 240, duration: 14 },
      },
    };
    expect(parseUpdate(CH, update)?.parts).toEqual([
      {
        kind: "video_note",
        mediaRef: { channelId: CH, externalRef: "vn1" },
        durationSec: 14,
      },
    ]);
  });

  it("парсит video_note с duration=0 — durationSec опущен", () => {
    const update: TgUpdate = {
      update_id: 13,
      message: {
        message_id: 14,
        chat: { id: 700, type: "private" },
        from: { id: 700 },
        date: 1700000000,
        video_note: { file_id: "vn2", file_unique_id: "vnu2", length: 240, duration: 0 },
      },
    };
    expect(parseUpdate(CH, update)?.parts).toEqual([
      { kind: "video_note", mediaRef: { channelId: CH, externalRef: "vn2" } },
    ]);
  });

  it("caption без media и без text → трактуется как text", () => {
    const update: TgUpdate = {
      update_id: 14,
      message: {
        message_id: 15,
        chat: { id: 800, type: "private" },
        from: { id: 800 },
        date: 1700000000,
        caption: "stray caption",
      },
    };
    expect(parseUpdate(CH, update)?.parts).toEqual([{ kind: "text", text: "stray caption" }]);
  });

  it("edited_message парсится как обычное сообщение", () => {
    const update: TgUpdate = {
      update_id: 15,
      edited_message: {
        message_id: 16,
        chat: { id: 900, type: "private" },
        from: { id: 900 },
        date: 1700000001,
        text: "fixed typo",
      },
    };
    const inbound = parseUpdate(CH, update);
    expect(inbound?.externalMessageId).toBe("16");
    expect(inbound?.parts).toEqual([{ kind: "text", text: "fixed typo" }]);
  });

  it("callback_query без data → null", () => {
    const update: TgUpdate = {
      update_id: 16,
      callback_query: {
        id: "cb-1",
        from: { id: 1 },
        message: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 },
      },
    };
    expect(parseUpdate(CH, update)).toBeNull();
  });

  it("callback_query без message → null", () => {
    const update: TgUpdate = {
      update_id: 17,
      callback_query: { id: "cb-2", from: { id: 1 }, data: "x" },
    };
    expect(parseUpdate(CH, update)).toBeNull();
  });

  it("возвращает null для пустого update без message/callback", () => {
    expect(parseUpdate(CH, { update_id: 6 })).toBeNull();
  });

  it("возвращает null для сообщения без 'from' (анонимные канал-посты)", () => {
    const update: TgUpdate = {
      update_id: 7,
      message: {
        message_id: 1,
        chat: { id: 1, type: "channel" },
        date: 1700000000,
        text: "anon",
      },
    };
    expect(parseUpdate(CH, update)).toBeNull();
  });
});
