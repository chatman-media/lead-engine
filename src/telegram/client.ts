import type {
  TgReplyMarkup,
  TgSendMessageResult,
  TgUser,
} from "./types.ts";

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

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
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

  getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe", {});
  }

  sendMessage(input: {
    chatId: number | string;
    text: string;
    parseMode?: "MarkdownV2" | "HTML" | "Markdown";
    replyMarkup?: TgReplyMarkup;
    disableWebPagePreview?: boolean;
    replyToMessageId?: number;
  }): Promise<TgSendMessageResult> {
    const params: Record<string, unknown> = {
      chat_id: input.chatId,
      text: input.text,
    };
    if (input.parseMode) params.parse_mode = input.parseMode;
    if (input.replyMarkup) params.reply_markup = input.replyMarkup;
    if (input.disableWebPagePreview)
      params.disable_web_page_preview = input.disableWebPagePreview;
    if (input.replyToMessageId !== undefined)
      params.reply_to_message_id = input.replyToMessageId;
    return this.call<TgSendMessageResult>("sendMessage", params);
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
   * Acknowledge an inline-keyboard click. Telegram requires a response
   * within a few seconds or the spinner on the user's button keeps
   * rotating. Pass `text` to flash a small notification ("Approved!").
   */
  answerCallbackQuery(input: {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
  }): Promise<true> {
    const params: Record<string, unknown> = {
      callback_query_id: input.callbackQueryId,
    };
    if (input.text) params.text = input.text;
    if (input.showAlert) params.show_alert = input.showAlert;
    return this.call<true>("answerCallbackQuery", params);
  }

  sendChatAction(input: {
    chatId: number | string;
    action:
      | "typing"
      | "upload_photo"
      | "record_video"
      | "upload_voice"
      | "upload_document";
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
    return this.call<{ url: string; pending_update_count: number }>(
      "getWebhookInfo",
      {},
    );
  }
}
