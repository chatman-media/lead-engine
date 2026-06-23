import type { Inbound } from "@chatman-media/channel-core";
import type { MaxMessage, MaxMessageCreatedUpdate, MaxUpdate } from "./types.ts";

function isMessageCreatedUpdate(payload: MaxUpdate): payload is MaxMessageCreatedUpdate {
  return (
    payload.update_type === "message_created" &&
    typeof (payload as { message?: unknown }).message === "object" &&
    (payload as { message?: unknown }).message !== null
  );
}

function toUnixSeconds(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : Date.now();
  return Math.floor(n > 99_999_999_999 ? n / 1000 : n);
}

function externalUserIdForMessage(message: MaxMessage): string | null {
  const chatType = message.recipient?.chat_type;
  const chatId = message.recipient?.chat_id;
  const userId = message.sender?.user_id;
  if (chatType === "dialog" && typeof userId === "number") return `user:${userId}`;
  if (typeof chatId === "number") return `chat:${chatId}`;
  if (typeof userId === "number") return `user:${userId}`;
  return null;
}

/**
 * Конвертит MAX Bot API Update в Inbound[]. MVP обрабатывает text-only
 * `message_created`; unsupported media/callback events пропускаются.
 */
export function parseUpdatePayload(channelId: string, payload: MaxUpdate): Inbound[] {
  if (!isMessageCreatedUpdate(payload)) return [];

  const message = payload.message;
  if (message.sender?.is_bot) return [];

  const text = message.body?.text;
  if (typeof text !== "string" || !text.trim()) return [];

  const externalUserId = externalUserIdForMessage(message);
  if (!externalUserId) return [];

  return [
    {
      channelId,
      externalMessageId:
        message.body?.mid ??
        `${externalUserId}:${toUnixSeconds(message.timestamp || payload.timestamp)}`,
      externalUserId,
      ...(message.sender?.username ? { externalUsername: message.sender.username } : {}),
      parts: [{ kind: "text", text }],
      receivedAt: toUnixSeconds(message.timestamp || payload.timestamp),
      raw: payload,
    },
  ];
}
