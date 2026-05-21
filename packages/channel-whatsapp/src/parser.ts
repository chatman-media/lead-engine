import type { Inbound, InboundPart, MediaRef } from "@chatman-media/channel-core";
import type { WaMessage, WaWebhookPayload } from "./types.ts";

const ref = (channelId: string, externalRef: string): MediaRef => ({ channelId, externalRef });

function partsFromWaMessage(channelId: string, msg: WaMessage): InboundPart[] {
  const parts: InboundPart[] = [];

  if (msg.type === "text" && msg.text?.body) {
    parts.push({ kind: "text", text: msg.text.body });
    return parts;
  }
  if (msg.image) {
    parts.push({
      kind: "photo",
      mediaRef: ref(channelId, msg.image.id),
      ...(msg.image.caption ? { caption: msg.image.caption } : {}),
    });
    return parts;
  }
  if (msg.video) {
    parts.push({
      kind: "video",
      mediaRef: ref(channelId, msg.video.id),
      ...(msg.video.caption ? { caption: msg.video.caption } : {}),
    });
    return parts;
  }
  if (msg.audio || msg.voice) {
    const m = msg.voice ?? msg.audio!;
    parts.push({ kind: "voice", mediaRef: ref(channelId, m.id) });
    return parts;
  }
  if (msg.document) {
    parts.push({
      kind: "document",
      mediaRef: ref(channelId, msg.document.id),
      ...(msg.document.mime_type ? { mimeType: msg.document.mime_type } : {}),
      ...(msg.document.filename ? { fileName: msg.document.filename } : {}),
    });
    return parts;
  }
  return parts;
}

/**
 * Конвертит WhatsApp Cloud webhook payload в массив Inbound'ов. Один
 * webhook может содержать несколько messages (batch), для каждого
 * выкидываем отдельный Inbound.
 *
 * Skipпает: системные status-update'ы (delivered/read), reactions, unknown
 * message-типы (interactive с unsupported sub-types).
 */
export function parseWebhookPayload(channelId: string, payload: WaWebhookPayload): Inbound[] {
  const out: Inbound[] = [];
  if (!payload.entry || !Array.isArray(payload.entry)) return out;

  for (const entry of payload.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const messages = change.value?.messages ?? [];
      const contacts = change.value?.contacts ?? [];
      for (const msg of messages) {
        const parts = partsFromWaMessage(channelId, msg);
        if (parts.length === 0) continue;
        const username = contacts.find((c) => c.wa_id === msg.from)?.profile?.name;
        const ts = Number.parseInt(msg.timestamp, 10);
        out.push({
          channelId,
          externalMessageId: msg.id,
          externalUserId: msg.from,
          ...(username ? { externalUsername: username } : {}),
          parts,
          receivedAt: Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000),
          raw: { entry, change, msg },
        });
      }
    }
  }
  return out;
}
