import type { Inbound, InboundPart, MediaRef } from "@chatman-media/channel-core";
import type { FbAttachment, FbMessagingEvent, FbWebhookPayload } from "./types.ts";

const ref = (channelId: string, externalRef: string): MediaRef => ({ channelId, externalRef });

/** Маппинг типа Messenger-аттача в InboundPart (externalRef = URL медиа). */
function partFromAttachment(channelId: string, att: FbAttachment): InboundPart | null {
  const url = att.payload?.url;
  if (!url) return null; // стикеры / fallback без url — пропускаем
  const mediaRef = ref(channelId, url);
  switch (att.type) {
    case "image":
      return { kind: "photo", mediaRef };
    case "video":
      return { kind: "video", mediaRef };
    case "audio":
      return { kind: "voice", mediaRef };
    case "file":
      return { kind: "document", mediaRef };
    default:
      return null;
  }
}

function partsFromEvent(channelId: string, ev: FbMessagingEvent): InboundPart[] {
  const parts: InboundPart[] = [];

  // Postback (нажатие кнопки) → callback_query.
  if (ev.postback) {
    parts.push({
      kind: "callback_query",
      data: ev.postback.payload,
      originalMessageId: ev.postback.mid ?? "",
    });
    return parts;
  }

  const msg = ev.message;
  if (!msg || msg.is_echo) return parts; // echo собственных / не-сообщение

  if (typeof msg.text === "string" && msg.text.length > 0) {
    parts.push({ kind: "text", text: msg.text });
  }
  for (const att of msg.attachments ?? []) {
    const p = partFromAttachment(channelId, att);
    if (p) parts.push(p);
  }
  // quick_reply без текста — трактуем payload как callback_query.
  if (parts.length === 0 && msg.quick_reply) {
    parts.push({
      kind: "callback_query",
      data: msg.quick_reply.payload,
      originalMessageId: msg.mid,
    });
  }
  return parts;
}

/**
 * Конвертит Facebook Messenger webhook payload (`object: "page"`) в массив
 * Inbound'ов. Один webhook может содержать несколько `entry`, каждый —
 * несколько messaging-событий; для каждого с контентом выкидываем отдельный
 * Inbound.
 *
 * Skipпает: echo собственных сообщений, delivery/read статусы, аттачи без url.
 * `externalUsername` в webhook не приходит (нужен отдельный Graph-запрос
 * `GET /<PSID>?fields=name`) — поэтому опускается.
 */
export function parseWebhookPayload(channelId: string, payload: FbWebhookPayload): Inbound[] {
  const out: Inbound[] = [];
  if (!payload.entry || !Array.isArray(payload.entry)) return out;

  for (const entry of payload.entry) {
    for (const ev of entry.messaging ?? []) {
      if (!ev.sender?.id) continue;
      const parts = partsFromEvent(channelId, ev);
      if (parts.length === 0) continue;
      const mid = ev.message?.mid ?? ev.postback?.mid ?? `${ev.sender.id}:${ev.timestamp}`;
      const tsMs = typeof ev.timestamp === "number" ? ev.timestamp : Number.NaN;
      const receivedAt = Number.isFinite(tsMs)
        ? Math.floor(tsMs / 1000)
        : Math.floor(Date.now() / 1000);
      out.push({
        channelId,
        externalMessageId: mid,
        externalUserId: ev.sender.id,
        parts,
        receivedAt,
        raw: { entry, ev },
      });
    }
  }
  return out;
}
