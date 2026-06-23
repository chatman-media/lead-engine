import type { Inbound } from "@chatman-media/channel-core";
import type { VkCallbackPayload, VkMessageNewObject } from "./types.ts";

function isMessageNewObject(x: unknown): x is VkMessageNewObject {
  if (!x || typeof x !== "object") return false;
  const msg = (x as { message?: unknown }).message;
  if (!msg || typeof msg !== "object") return false;
  return typeof (msg as { peer_id?: unknown }).peer_id === "number";
}

function messageId(msg: VkMessageNewObject["message"]): string {
  if (typeof msg.id === "number" && msg.id > 0) return String(msg.id);
  if (typeof msg.conversation_message_id === "number" && msg.conversation_message_id > 0) {
    return `cmid:${msg.peer_id}:${msg.conversation_message_id}`;
  }
  return `${msg.peer_id}:${msg.date ?? Math.floor(Date.now() / 1000)}`;
}

/**
 * Конвертит VK Callback API payload в Inbound[]. MVP обрабатывает text-only
 * `message_new`; unsupported attachments пропускаются, чтобы не ломать webhook.
 */
export function parseCallbackPayload(channelId: string, payload: VkCallbackPayload): Inbound[] {
  if (payload.type !== "message_new") return [];
  if (!isMessageNewObject(payload.object)) return [];

  const msg = payload.object.message;
  if (msg.out === 1) return [];

  const parts =
    typeof msg.text === "string" && msg.text.trim()
      ? [{ kind: "text" as const, text: msg.text }]
      : [];
  if (parts.length === 0) return [];

  return [
    {
      channelId,
      externalMessageId: messageId(msg),
      externalUserId: String(msg.peer_id),
      parts,
      receivedAt: typeof msg.date === "number" ? msg.date : Math.floor(Date.now() / 1000),
      raw: payload,
    },
  ];
}
