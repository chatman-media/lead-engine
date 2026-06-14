import type { Inbound, InboundPart, MediaRef } from "@chatman-media/channel-core";
import type { TgMessage, TgPhotoSize, TgUpdate } from "./types.ts";

const ref = (channelId: string, externalRef: string): MediaRef => ({
  channelId,
  externalRef,
});

/**
 * Берёт самую крупную доступную size фотографии. Telegram отдаёт массив
 * sizes отсортированный по размеру; мы хотим original.
 */
function largestPhoto(photo: TgPhotoSize[]): TgPhotoSize | undefined {
  if (photo.length === 0) return undefined;
  return photo.reduce((biggest, current) =>
    current.width * current.height > biggest.width * biggest.height ? current : biggest,
  );
}

function partsFromMessage(channelId: string, msg: TgMessage): InboundPart[] {
  const parts: InboundPart[] = [];

  // Caption у photo/video/document обрабатывается ВНУТРИ соответствующего part'а,
  // а у голого текстового message живёт в .text.
  if (msg.text) {
    parts.push({ kind: "text", text: msg.text });
  }

  if (msg.photo && msg.photo.length > 0) {
    const biggest = largestPhoto(msg.photo);
    if (biggest) {
      const caption = msg.caption ?? undefined;
      parts.push({
        kind: "photo",
        mediaRef: ref(channelId, biggest.file_id),
        ...(caption ? { caption } : {}),
      });
    }
  } else if (msg.video) {
    parts.push({
      kind: "video",
      mediaRef: ref(channelId, msg.video.file_id),
      ...(msg.caption ? { caption: msg.caption } : {}),
    });
  } else if (msg.voice) {
    parts.push({
      kind: "voice",
      mediaRef: ref(channelId, msg.voice.file_id),
      durationSec: msg.voice.duration,
    });
  } else if (msg.video_note) {
    // «Кружок» — видео-сообщение Telegram. Используется для видео-верификации.
    parts.push({
      kind: "video_note",
      mediaRef: ref(channelId, msg.video_note.file_id),
      ...(msg.video_note.duration ? { durationSec: msg.video_note.duration } : {}),
    });
  } else if (msg.document) {
    parts.push({
      kind: "document",
      mediaRef: ref(channelId, msg.document.file_id),
      ...(msg.document.mime_type ? { mimeType: msg.document.mime_type } : {}),
      ...(msg.document.file_name ? { fileName: msg.document.file_name } : {}),
    });
  } else if (!msg.text && msg.caption) {
    // Caption без media — теоретически невозможно по Bot API, но обработаем как text.
    parts.push({ kind: "text", text: msg.caption });
  }

  return parts;
}

/**
 * Маппит сырой Telegram Update в канал-агностичный Inbound (или null если
 * update не относится к диалогу — например, чисто edited_message без изменений
 * нашему пайплайну неинтересен).
 */
export function parseUpdate(channelId: string, update: TgUpdate): Inbound | null {
  if (update.callback_query) {
    const cb = update.callback_query;
    const messageId = cb.message?.message_id;
    if (cb.data === undefined || messageId === undefined) return null;
    return {
      channelId,
      externalMessageId: String(cb.message?.message_id ?? cb.id),
      externalUserId: String(cb.from.id),
      ...(cb.from.username ? { externalUsername: cb.from.username } : {}),
      parts: [
        { kind: "callback_query", data: cb.data, originalMessageId: String(messageId) },
      ],
      receivedAt: Math.floor(Date.now() / 1000),
      raw: update,
    };
  }

  const msg = update.message ?? update.edited_message;
  if (!msg) return null;
  if (!msg.from) return null;

  // Правка ранее отправленного сообщения (message_id совпадает с исходным).
  // conversation-engine на edited обновит сохранённое сообщение и переответит,
  // а не дедупит как ретрай.
  const isEdit = !update.message && Boolean(update.edited_message);

  const parts = partsFromMessage(channelId, msg);
  if (parts.length === 0) return null;

  return {
    channelId,
    externalMessageId: String(msg.message_id),
    externalUserId: String(msg.from.id),
    ...(msg.from.username ? { externalUsername: msg.from.username } : {}),
    parts,
    receivedAt: msg.date,
    ...(isEdit ? { edited: true } : {}),
    raw: update,
  };
}
