import { describe, expect, it } from "bun:test";
import { parseWebhookPayload } from "./parser.ts";
import type { WaWebhookPayload } from "./types.ts";

const CH = "wa-1";

function envelope(messages: WaWebhookPayload["entry"][0]["changes"][0]["value"]["messages"], contacts?: WaWebhookPayload["entry"][0]["changes"][0]["value"]["contacts"]): WaWebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "biz-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              ...(contacts ? { contacts } : {}),
              messages,
            },
          },
        ],
      },
    ],
  };
}

describe("parseWebhookPayload", () => {
  it("парсит text сообщение", () => {
    const out = parseWebhookPayload(
      CH,
      envelope([
        { from: "79161234567", id: "wa.M1", timestamp: "1700000000", type: "text", text: { body: "hi" } },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      channelId: CH,
      externalMessageId: "wa.M1",
      externalUserId: "79161234567",
      parts: [{ kind: "text", text: "hi" }],
      receivedAt: 1700000000,
    });
  });

  it("включает externalUsername из contacts.profile.name", () => {
    const out = parseWebhookPayload(
      CH,
      envelope(
        [
          { from: "79161234567", id: "wa.M1", timestamp: "1700000000", type: "text", text: { body: "ok" } },
        ],
        [{ wa_id: "79161234567", profile: { name: "Alina" } }],
      ),
    );
    expect(out[0]?.externalUsername).toBe("Alina");
  });

  it("парсит image с caption → photo InboundPart", () => {
    const out = parseWebhookPayload(
      CH,
      envelope([
        {
          from: "79161234567",
          id: "wa.M2",
          timestamp: "1700000001",
          type: "image",
          image: { id: "media-IMG-1", mime_type: "image/jpeg", caption: "look" },
        },
      ]),
    );
    expect(out[0]?.parts).toEqual([
      {
        kind: "photo",
        mediaRef: { channelId: CH, externalRef: "media-IMG-1" },
        caption: "look",
      },
    ]);
  });

  it("voice сообщение → voice InboundPart", () => {
    const out = parseWebhookPayload(
      CH,
      envelope([
        {
          from: "79161234567",
          id: "wa.M3",
          timestamp: "1700000002",
          type: "voice",
          voice: { id: "media-VC-1", mime_type: "audio/ogg" },
        },
      ]),
    );
    expect(out[0]?.parts).toEqual([
      { kind: "voice", mediaRef: { channelId: CH, externalRef: "media-VC-1" } },
    ]);
  });

  it("document → document InboundPart с mimeType + fileName", () => {
    const out = parseWebhookPayload(
      CH,
      envelope([
        {
          from: "79161234567",
          id: "wa.M4",
          timestamp: "1700000003",
          type: "document",
          document: { id: "media-DOC-1", mime_type: "application/pdf", filename: "passport.pdf" },
        },
      ]),
    );
    expect(out[0]?.parts).toEqual([
      {
        kind: "document",
        mediaRef: { channelId: CH, externalRef: "media-DOC-1" },
        mimeType: "application/pdf",
        fileName: "passport.pdf",
      },
    ]);
  });

  it("batch — два сообщения в одном webhook", () => {
    const out = parseWebhookPayload(
      CH,
      envelope([
        { from: "79161234567", id: "wa.A", timestamp: "1700000000", type: "text", text: { body: "a" } },
        { from: "79161234567", id: "wa.B", timestamp: "1700000001", type: "text", text: { body: "b" } },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.externalMessageId)).toEqual(["wa.A", "wa.B"]);
  });

  it("status-update payload (нет messages array) → пусто", () => {
    const payload: WaWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "biz-1",
          changes: [{ field: "messages", value: { messaging_product: "whatsapp" } }],
        },
      ],
    };
    expect(parseWebhookPayload(CH, payload)).toEqual([]);
  });

  it("неизвестный type без media → skip (parts.length=0)", () => {
    const out = parseWebhookPayload(
      CH,
      envelope([
        { from: "79161234567", id: "wa.X", timestamp: "1700000000", type: "interactive" },
      ]),
    );
    expect(out).toEqual([]);
  });

  it("invalid timestamp → fallback на now", () => {
    const before = Math.floor(Date.now() / 1000);
    const out = parseWebhookPayload(
      CH,
      envelope([
        { from: "79161234567", id: "wa.M1", timestamp: "garbage", type: "text", text: { body: "hi" } },
      ]),
    );
    const after = Math.floor(Date.now() / 1000);
    expect(out[0]?.receivedAt).toBeGreaterThanOrEqual(before);
    expect(out[0]?.receivedAt).toBeLessThanOrEqual(after);
  });
});
