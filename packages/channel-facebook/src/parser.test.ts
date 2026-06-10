import { describe, expect, it } from "bun:test";
import { parseWebhookPayload } from "./parser.ts";
import type { FbMessagingEvent, FbWebhookPayload } from "./types.ts";

const CH = "fb-1";
const PSID = "PSID-1";

function page(messaging: FbMessagingEvent[]): FbWebhookPayload {
  return { object: "page", entry: [{ id: "PAGE-1", time: 1_700_000_000_000, messaging }] };
}

function ev(over: Partial<FbMessagingEvent>): FbMessagingEvent {
  return {
    sender: { id: PSID },
    recipient: { id: "PAGE-1" },
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

describe("parseWebhookPayload (Messenger)", () => {
  it("парсит text сообщение + конвертит timestamp ms → sec", () => {
    const out = parseWebhookPayload(CH, page([ev({ message: { mid: "m.M1", text: "hi" } })]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      channelId: CH,
      externalMessageId: "m.M1",
      externalUserId: PSID,
      parts: [{ kind: "text", text: "hi" }],
      receivedAt: 1_700_000_000,
    });
  });

  it("image attachment → photo InboundPart (externalRef = url)", () => {
    const out = parseWebhookPayload(
      CH,
      page([ev({ message: { mid: "m.M2", attachments: [{ type: "image", payload: { url: "https://cdn/i.jpg" } }] } })]),
    );
    expect(out[0]?.parts).toEqual([
      { kind: "photo", mediaRef: { channelId: CH, externalRef: "https://cdn/i.jpg" } },
    ]);
  });

  it("video attachment → video InboundPart", () => {
    const out = parseWebhookPayload(
      CH,
      page([ev({ message: { mid: "m.MV", attachments: [{ type: "video", payload: { url: "https://cdn/v.mp4" } }] } })]),
    );
    expect(out[0]?.parts).toEqual([
      { kind: "video", mediaRef: { channelId: CH, externalRef: "https://cdn/v.mp4" } },
    ]);
  });

  it("audio → voice, file → document", () => {
    const audio = parseWebhookPayload(
      CH,
      page([ev({ message: { mid: "a", attachments: [{ type: "audio", payload: { url: "u-a" } }] } })]),
    );
    expect(audio[0]?.parts).toEqual([{ kind: "voice", mediaRef: { channelId: CH, externalRef: "u-a" } }]);

    const file = parseWebhookPayload(
      CH,
      page([ev({ message: { mid: "f", attachments: [{ type: "file", payload: { url: "u-f" } }] } })]),
    );
    expect(file[0]?.parts).toEqual([{ kind: "document", mediaRef: { channelId: CH, externalRef: "u-f" } }]);
  });

  it("text + attachment в одном сообщении → две части", () => {
    const out = parseWebhookPayload(
      CH,
      page([ev({ message: { mid: "m.M5", text: "look", attachments: [{ type: "image", payload: { url: "u" } }] } })]),
    );
    expect(out[0]?.parts).toEqual([
      { kind: "text", text: "look" },
      { kind: "photo", mediaRef: { channelId: CH, externalRef: "u" } },
    ]);
  });

  it("postback → callback_query", () => {
    const out = parseWebhookPayload(
      CH,
      page([ev({ postback: { mid: "m.P1", payload: "BUY_USDT", title: "Buy" } })]),
    );
    expect(out[0]?.parts).toEqual([
      { kind: "callback_query", data: "BUY_USDT", originalMessageId: "m.P1" },
    ]);
  });

  it("quick_reply без текста → callback_query", () => {
    const out = parseWebhookPayload(
      CH,
      page([ev({ message: { mid: "m.QR", quick_reply: { payload: "RUB" } } })]),
    );
    expect(out[0]?.parts).toEqual([{ kind: "callback_query", data: "RUB", originalMessageId: "m.QR" }]);
  });

  it("echo собственного сообщения → skip", () => {
    const out = parseWebhookPayload(
      CH,
      page([ev({ message: { mid: "m.E", text: "echo", is_echo: true } })]),
    );
    expect(out).toEqual([]);
  });

  it("delivery / read статус-события (без message) → skip", () => {
    const out = parseWebhookPayload(
      CH,
      page([ev({ delivery: { mids: ["m.x"] } }), ev({ read: { watermark: 1 } })]),
    );
    expect(out).toEqual([]);
  });

  it("attachment неизвестного типа (location) → skip", () => {
    const out = parseWebhookPayload(
      CH,
      page([ev({ message: { mid: "m.L", attachments: [{ type: "location", payload: { url: "u-l" } }] } })]),
    );
    expect(out).toEqual([]);
  });

  it("attachment без url (стикер/fallback) → skip", () => {
    const out = parseWebhookPayload(
      CH,
      page([ev({ message: { mid: "m.S", attachments: [{ type: "image", payload: { sticker_id: 369 } }] } })]),
    );
    expect(out).toEqual([]);
  });

  it("batch — два messaging-события в одном webhook", () => {
    const out = parseWebhookPayload(
      CH,
      page([
        ev({ message: { mid: "m.A", text: "a" } }),
        ev({ sender: { id: "PSID-2" }, message: { mid: "m.B", text: "b" } }),
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.externalMessageId)).toEqual(["m.A", "m.B"]);
    expect(out.map((i) => i.externalUserId)).toEqual([PSID, "PSID-2"]);
  });

  it("невалидный timestamp → fallback на now", () => {
    const before = Math.floor(Date.now() / 1000);
    const out = parseWebhookPayload(
      CH,
      page([ev({ timestamp: Number.NaN, message: { mid: "m.T", text: "x" } })]),
    );
    const after = Math.floor(Date.now() / 1000);
    expect(out[0]?.receivedAt).toBeGreaterThanOrEqual(before);
    expect(out[0]?.receivedAt).toBeLessThanOrEqual(after);
  });

  it("payload без entry → пусто", () => {
    expect(parseWebhookPayload(CH, { object: "page" } as unknown as FbWebhookPayload)).toEqual([]);
  });
});
