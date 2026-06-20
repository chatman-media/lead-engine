import type { TgFile, TgReplyMarkup, TgSendMessageResult, TgUser } from "./types.ts";

export type FetchLike = typeof fetch;

export interface TelegramClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export class TelegramApiError extends Error {
  constructor(
    public method: string,
    public statusCode: number,
    public errorCode: number | undefined,
    public description: string,
  ) {
    super(`Telegram ${method} failed (${statusCode}): ${description}`);
    this.name = "TelegramApiError";
  }
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: TelegramClientOptions) {
    if (!opts.token) throw new Error("TelegramClient: token is required");
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://api.telegram.org";
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async parseResponse<T>(method: string, res: Response): Promise<T> {
    let body: TgResponse<T>;
    try {
      body = (await res.json()) as TgResponse<T>;
    } catch {
      throw new TelegramApiError(
        method,
        res.status,
        undefined,
        `non-JSON response (status ${res.status})`,
      );
    }
    if (!res.ok || !body.ok || body.result === undefined) {
      throw new TelegramApiError(
        method,
        res.status,
        body.error_code,
        body.description ?? "unknown error",
      );
    }
    return body.result;
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return this.parseResponse<T>(method, res);
  }

  private async callMultipart<T>(
    method: string,
    params: Record<string, unknown>,
    file: {
      field: string;
      bytes: ArrayBuffer | Uint8Array;
      filename: string;
      contentType?: string;
    },
  ): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      form.append(key, String(value));
    }
    form.append(
      file.field,
      new Blob([toArrayBuffer(file.bytes)], {
        type: file.contentType ?? "application/octet-stream",
      }),
      file.filename,
    );
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      body: form,
    });
    return this.parseResponse<T>(method, res);
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe", {});
  }

  /**
   * Resolve a file_id to a downloadable path. The path returned is
   * appended to `<baseUrl>/file/bot<token>/...` (NOT the regular
   * `<baseUrl>/bot<token>/...` API endpoint) — see `downloadFile` for
   * the right URL shape.
   */
  getFile(fileId: string): Promise<TgFile> {
    return this.call<TgFile>("getFile", { file_id: fileId });
  }

  /**
   * Two-step download for any file_id we hold:
   *   1. getFile → returns `file_path`
   *   2. fetch the bytes from `<baseUrl>/file/bot<token>/<file_path>`
   *
   * Returns the raw `Response` so the admin layer can stream the body
   * straight to the browser without buffering. Throws when the file is
   * too large for the Bot Download API (Telegram's ~20 MB cap leaves
   * `file_path` undefined).
   *
   * The token is held privately by the client — the admin endpoint
   * proxies through this helper rather than getting the token directly,
   * so secrets never leave the server.
   */
  async downloadFile(fileId: string): Promise<Response> {
    const info = await this.getFile(fileId);
    if (!info.file_path) {
      throw new Error(`Telegram file ${fileId} has no file_path (too large?)`);
    }
    const url = `${this.baseUrl}/file/bot${this.token}/${info.file_path}`;
    return this.fetchImpl(url);
  }

  sendMessage(input: {
    chatId: number | string;
    text: string;
    parseMode?: "MarkdownV2" | "HTML" | "Markdown";
    replyMarkup?: TgReplyMarkup;
    disableWebPagePreview?: boolean;
    replyToMessageId?: number;
    /** Топик форум-группы (operator bot): сообщение уходит в конкретный тред. */
    messageThreadId?: number;
  }): Promise<TgSendMessageResult> {
    const params: Record<string, unknown> = {
      chat_id: input.chatId,
      text: input.text,
    };
    if (input.parseMode) params.parse_mode = input.parseMode;
    if (input.replyMarkup) params.reply_markup = input.replyMarkup;
    if (input.disableWebPagePreview) params.disable_web_page_preview = input.disableWebPagePreview;
    if (input.replyToMessageId !== undefined) params.reply_to_message_id = input.replyToMessageId;
    if (input.messageThreadId !== undefined) params.message_thread_id = input.messageThreadId;
    return this.call<TgSendMessageResult>("sendMessage", params);
  }

  /**
   * Создать топик в форум-группе (operator bot). Требует: группа = форум, бот —
   * админ с правом Manage Topics. Возвращает message_thread_id топика, который
   * мы сохраняем на диалоге и используем для маршрутизации карточек/ответов.
   */
  createForumTopic(input: {
    chatId: number | string;
    name: string;
    iconColor?: number;
  }): Promise<{ message_thread_id: number; name: string }> {
    const params: Record<string, unknown> = {
      chat_id: input.chatId,
      name: input.name,
    };
    if (input.iconColor !== undefined) params.icon_color = input.iconColor;
    return this.call<{ message_thread_id: number; name: string }>("createForumTopic", params);
  }

  /**
   * Re-send a photo by file_id. Used by the operator-relay path: when the
   * operator uploads a photo to the ops chat as a reply to a lead card,
   * the webhook hands the largest size's file_id straight to this method
   * — Telegram is happy to re-deliver media we've already seen, no need
   * to download and re-upload bytes.
   */
  sendPhoto(input: {
    chatId: number | string;
    photoFileId: string;
    caption?: string;
    /** Топик форум-группы (operator bot): медиа уходит в конкретный тред. */
    messageThreadId?: number;
  }): Promise<TgSendMessageResult> {
    const params: Record<string, unknown> = {
      chat_id: input.chatId,
      photo: input.photoFileId,
    };
    if (input.caption) params.caption = input.caption;
    if (input.messageThreadId !== undefined) params.message_thread_id = input.messageThreadId;
    return this.call<TgSendMessageResult>("sendPhoto", params);
  }

  sendLocation(input: {
    chatId: number | string;
    latitude: number;
    longitude: number;
  }): Promise<TgSendMessageResult> {
    return this.call<TgSendMessageResult>("sendLocation", {
      chat_id: input.chatId,
      latitude: input.latitude,
      longitude: input.longitude,
    });
  }

  sendVideo(input: {
    chatId: number | string;
    videoFileId: string;
    caption?: string;
    messageThreadId?: number;
  }): Promise<TgSendMessageResult> {
    const params: Record<string, unknown> = {
      chat_id: input.chatId,
      video: input.videoFileId,
    };
    if (input.caption) params.caption = input.caption;
    if (input.messageThreadId !== undefined) params.message_thread_id = input.messageThreadId;
    return this.call<TgSendMessageResult>("sendVideo", params);
  }

  sendVideoNote(input: {
    chatId: number | string;
    videoNoteFileId: string;
    messageThreadId?: number;
  }): Promise<TgSendMessageResult> {
    const params: Record<string, unknown> = {
      chat_id: input.chatId,
      video_note: input.videoNoteFileId,
    };
    if (input.messageThreadId !== undefined) params.message_thread_id = input.messageThreadId;
    return this.call<TgSendMessageResult>("sendVideoNote", params);
  }

  sendPhotoUpload(input: {
    chatId: number | string;
    bytes: ArrayBuffer | Uint8Array;
    filename: string;
    contentType?: string;
    caption?: string;
    messageThreadId?: number;
  }): Promise<TgSendMessageResult> {
    return this.callMultipart<TgSendMessageResult>(
      "sendPhoto",
      {
        chat_id: input.chatId,
        caption: input.caption,
        message_thread_id: input.messageThreadId,
      },
      {
        field: "photo",
        bytes: input.bytes,
        filename: input.filename,
        contentType: input.contentType,
      },
    );
  }

  sendVideoUpload(input: {
    chatId: number | string;
    bytes: ArrayBuffer | Uint8Array;
    filename: string;
    contentType?: string;
    caption?: string;
    messageThreadId?: number;
  }): Promise<TgSendMessageResult> {
    return this.callMultipart<TgSendMessageResult>(
      "sendVideo",
      {
        chat_id: input.chatId,
        caption: input.caption,
        message_thread_id: input.messageThreadId,
      },
      {
        field: "video",
        bytes: input.bytes,
        filename: input.filename,
        contentType: input.contentType,
      },
    );
  }

  sendVideoNoteUpload(input: {
    chatId: number | string;
    bytes: ArrayBuffer | Uint8Array;
    filename: string;
    contentType?: string;
    messageThreadId?: number;
  }): Promise<TgSendMessageResult> {
    return this.callMultipart<TgSendMessageResult>(
      "sendVideoNote",
      { chat_id: input.chatId, message_thread_id: input.messageThreadId },
      {
        field: "video_note",
        bytes: input.bytes,
        filename: input.filename,
        contentType: input.contentType,
      },
    );
  }

  /**
   * Send a video from a local file on disk (not a Telegram `file_id`).
   * Bot API supports this via multipart upload, but our funnel goes through
   * the userbot — implemented as a stub here so the symbol resolves; the
   * real impl lives in `makeUserbotSender` in `userbot.ts` and uses gramjs
   * `sendFile` under the hood.
   */
  sendLocalVideo(_input: {
    chatId: number | string;
    localFilePath: string;
    caption?: string;
  }): Promise<TgSendMessageResult> {
    throw new Error("sendLocalVideo: Bot API path not implemented — userbot-only feature");
  }

  sendDocument(input: {
    chatId: number | string;
    documentFileId: string;
    caption?: string;
    messageThreadId?: number;
  }): Promise<TgSendMessageResult> {
    const params: Record<string, unknown> = {
      chat_id: input.chatId,
      document: input.documentFileId,
    };
    if (input.caption) params.caption = input.caption;
    if (input.messageThreadId !== undefined) params.message_thread_id = input.messageThreadId;
    return this.call<TgSendMessageResult>("sendDocument", params);
  }

  sendDocumentUpload(input: {
    chatId: number | string;
    bytes: ArrayBuffer | Uint8Array;
    filename: string;
    contentType?: string;
    caption?: string;
    messageThreadId?: number;
  }): Promise<TgSendMessageResult> {
    return this.callMultipart<TgSendMessageResult>(
      "sendDocument",
      {
        chat_id: input.chatId,
        caption: input.caption,
        message_thread_id: input.messageThreadId,
      },
      {
        field: "document",
        bytes: input.bytes,
        filename: input.filename,
        contentType: input.contentType,
      },
    );
  }

  /**
   * Edit a message we previously sent (commonly the lead card after the
   * operator clicks approve/reject — the card stays in the ops chat with
   * the new state visible). `text` replaces the body; `replyMarkup`
   * replaces the inline keyboard (pass `{}` to remove the buttons
   * entirely on a finalized state).
   */
  editMessageText(input: {
    chatId: number | string;
    messageId: number;
    text: string;
    parseMode?: "MarkdownV2" | "HTML" | "Markdown";
    replyMarkup?: TgReplyMarkup;
  }): Promise<TgSendMessageResult | true> {
    const params: Record<string, unknown> = {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
    };
    if (input.parseMode) params.parse_mode = input.parseMode;
    if (input.replyMarkup) params.reply_markup = input.replyMarkup;
    return this.call<TgSendMessageResult | true>("editMessageText", params);
  }

  /**
   * Delete a message we previously sent. Used by the admin "delete message"
   * action on the Bot-API channel. Telegram lets a bot delete its own
   * outgoing messages in a private chat with no time limit.
   */
  deleteMessage(input: { chatId: number | string; messageId: number }): Promise<true> {
    return this.call<true>("deleteMessage", {
      chat_id: input.chatId,
      message_id: input.messageId,
    });
  }

  /**
   * Acknowledge an inline-keyboard click. Telegram requires a response
   * within a few seconds or the spinner on the user's button keeps
   * rotating. Pass `text` to flash a small notification ("Approved!").
   */
  answerCallbackQuery(input: {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
    url?: string;
  }): Promise<true> {
    const params: Record<string, unknown> = {
      callback_query_id: input.callbackQueryId,
    };
    if (input.text) params.text = input.text;
    if (input.showAlert) params.show_alert = input.showAlert;
    if (input.url) params.url = input.url;
    return this.call<true>("answerCallbackQuery", params);
  }

  sendChatAction(input: {
    chatId: number | string;
    action: "typing" | "upload_photo" | "record_video" | "upload_voice" | "upload_document";
  }): Promise<true> {
    return this.call<true>("sendChatAction", {
      chat_id: input.chatId,
      action: input.action,
    });
  }

  setWebhook(input: {
    url: string;
    secretToken?: string;
    allowedUpdates?: string[];
    dropPendingUpdates?: boolean;
  }): Promise<true> {
    const params: Record<string, unknown> = { url: input.url };
    if (input.secretToken) params.secret_token = input.secretToken;
    if (input.allowedUpdates) params.allowed_updates = input.allowedUpdates;
    if (input.dropPendingUpdates !== undefined)
      params.drop_pending_updates = input.dropPendingUpdates;
    return this.call<true>("setWebhook", params);
  }

  deleteWebhook(dropPending = false): Promise<true> {
    return this.call<true>("deleteWebhook", {
      drop_pending_updates: dropPending,
    });
  }

  getWebhookInfo(): Promise<{ url: string; pending_update_count: number }> {
    return this.call<{ url: string; pending_update_count: number }>("getWebhookInfo", {});
  }
}
