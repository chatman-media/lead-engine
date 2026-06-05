// Минимальная обёртка над Meta Graph API для Facebook Messenger Platform:
//   POST /<API_VERSION>/me/messages — send (text / attachment / sender_action)
//   GET  /<API_VERSION>/me?fields=id,name — validate page token
//   GET  <attachment url> — download bytes (подписанный CDN-URL, без auth)
//
// Auth: Bearer <page_access_token>. Токен приходит из tenant_secrets, не из env.

export type FetchLike = typeof fetch;

export interface MessengerClientOptions {
  /** Page Access Token (long-lived). */
  pageAccessToken: string;
  /** API version, default "v18.0". */
  apiVersion?: string;
  /** Override base URL — для proxy / тестов. Default "https://graph.facebook.com". */
  baseUrl?: string;
  fetch?: FetchLike;
}

export class MessengerApiError extends Error {
  constructor(
    public method: string,
    public statusCode: number,
    public description: string,
  ) {
    super(`Messenger ${method} failed (${statusCode}): ${description}`);
    this.name = "MessengerApiError";
  }
}

export interface MessengerSendResponse {
  recipient_id?: string;
  message_id?: string;
}

export type MessengerAttachmentKind = "image" | "video" | "audio" | "file";

export class MessengerClient {
  private readonly pageAccessToken: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: MessengerClientOptions) {
    if (!opts.pageAccessToken) throw new Error("MessengerClient: pageAccessToken required");
    this.pageAccessToken = opts.pageAccessToken;
    this.apiVersion = opts.apiVersion ?? "v18.0";
    this.baseUrl = (opts.baseUrl ?? "https://graph.facebook.com").replace(/\/{1,512}$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string): string {
    return `${this.baseUrl}/${this.apiVersion}${path}`;
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.pageAccessToken}` };
  }

  /** POST /me/messages — общий путь отправки (text / attachment / action). */
  private async postMessage(method: string, body: unknown): Promise<MessengerSendResponse> {
    const res = await this.fetchImpl(this.url("/me/messages"), {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new MessengerApiError(method, res.status, await res.text().catch(() => "no body"));
    }
    return (await res.json().catch(() => ({}))) as MessengerSendResponse;
  }

  /**
   * Отправить text-сообщение. `to` — PSID (page-scoped user id).
   * `messaging_type: "RESPONSE"` — ответ в рамках 24-часового окна Messenger.
   */
  async sendText(input: { to: string; text: string }): Promise<{ messageId: string }> {
    const body = await this.postMessage("sendText", {
      recipient: { id: input.to },
      messaging_type: "RESPONSE",
      message: { text: input.text },
    });
    const id = body.message_id;
    if (!id) throw new MessengerApiError("sendText", 200, "no message_id in response");
    return { messageId: id };
  }

  /**
   * Отправить медиа по URL. Messenger принимает `payload.url` напрямую.
   * (Caption в attachment-сообщении не поддерживается — отправляется отдельным
   * текстом на уровне адаптера при необходимости.)
   */
  async sendAttachment(input: {
    to: string;
    kind: MessengerAttachmentKind;
    url: string;
  }): Promise<{ messageId: string }> {
    const body = await this.postMessage("sendAttachment", {
      recipient: { id: input.to },
      messaging_type: "RESPONSE",
      message: {
        attachment: { type: input.kind, payload: { url: input.url, is_reusable: false } },
      },
    });
    const id = body.message_id;
    if (!id) throw new MessengerApiError("sendAttachment", 200, "no message_id in response");
    return { messageId: id };
  }

  /** sender_action — индикатор "печатает" / "прочитано". */
  async sendAction(input: {
    to: string;
    action: "typing_on" | "typing_off" | "mark_seen";
  }): Promise<void> {
    await this.postMessage("sendAction", {
      recipient: { id: input.to },
      sender_action: input.action,
    });
  }

  /**
   * Validate page access token: GET /me?fields=id,name.
   * Бросает MessengerApiError на 401/403 (bad token). Используется при
   * onboarding'е канала в admin-панели.
   */
  async getPageInfo(): Promise<{ id: string; name?: string }> {
    const res = await this.fetchImpl(this.url("/me?fields=id,name"), {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new MessengerApiError(
        "getPageInfo",
        res.status,
        await res.text().catch(() => "no body"),
      );
    }
    const body = (await res.json()) as { id: string; name?: string };
    return { id: body.id, ...(body.name ? { name: body.name } : {}) };
  }

  /**
   * Скачать медиа по URL из webhook-аттача. Messenger отдаёт подписанные
   * CDN-URL (lookaside.fbsbx.com) — auth-заголовок не требуется. Возвращает
   * `Response` со stream'ом, чтобы caller пайпал в storage без буферизации.
   */
  async downloadMedia(url: string): Promise<Response> {
    const res = await this.fetchImpl(url, {});
    if (!res.ok) {
      throw new MessengerApiError(
        "downloadMedia",
        res.status,
        await res.text().catch(() => "no body"),
      );
    }
    return res;
  }
}
