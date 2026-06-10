// Минимальная обёртка над Meta Graph API для WhatsApp Cloud:
//   POST /<API_VERSION>/<phone_number_id>/messages — send
//   GET  /<API_VERSION>/<media_id> — resolve media → URL
//   GET  <returned URL with bearer> — download bytes
//
// Auth: Bearer <access_token>. Token приходит из tenant_secrets, не из env.

import type {
  WhatsAppTemplateComponent,
  WhatsAppTemplateMessage,
  WhatsAppTemplateParameter,
} from "@chatman-media/channel-core";

export type FetchLike = typeof fetch;

export interface WhatsAppClientOptions {
  /** Phone Number ID от Meta (не сам номер телефона). */
  phoneNumberId: string;
  /** Long-lived access token (system user token). */
  accessToken: string;
  /** API version, default "v18.0". */
  apiVersion?: string;
  /** Override base URL — для proxy / тестов. Default "https://graph.facebook.com". */
  baseUrl?: string;
  fetch?: FetchLike;
}

export class WhatsAppApiError extends Error {
  constructor(
    public method: string,
    public statusCode: number,
    public description: string,
  ) {
    super(`WhatsApp ${method} failed (${statusCode}): ${description}`);
    this.name = "WhatsAppApiError";
  }
}

export interface WhatsAppMessageResponse {
  messaging_product: "whatsapp";
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

function toTemplateParameter(param: WhatsAppTemplateParameter): Record<string, unknown> {
  if (param.type === "image" || param.type === "video" || param.type === "document") {
    return {
      type: param.type,
      [param.type]: { id: param.mediaRef.externalRef },
    };
  }
  return param;
}

function toTemplateComponent(component: WhatsAppTemplateComponent): Record<string, unknown> {
  return {
    type: component.type,
    ...(component.subType ? { sub_type: component.subType } : {}),
    ...(component.index ? { index: component.index } : {}),
    ...(component.parameters
      ? { parameters: component.parameters.map(toTemplateParameter) }
      : {}),
  };
}

export class WhatsAppClient {
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: WhatsAppClientOptions) {
    if (!opts.phoneNumberId) throw new Error("WhatsAppClient: phoneNumberId required");
    if (!opts.accessToken) throw new Error("WhatsAppClient: accessToken required");
    this.phoneNumberId = opts.phoneNumberId;
    this.accessToken = opts.accessToken;
    this.apiVersion = opts.apiVersion ?? "v18.0";
    this.baseUrl = (opts.baseUrl ?? "https://graph.facebook.com").replace(/\/{1,512}$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string): string {
    return `${this.baseUrl}/${this.apiVersion}${path}`;
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}` };
  }

  /**
   * Отправить text-сообщение. `to` — wa_id (телефон в международном формате
   * без `+`, например "79161234567").
   */
  async sendText(input: { to: string; text: string }): Promise<{ messageId: string }> {
    const res = await this.fetchImpl(this.url(`/${this.phoneNumberId}/messages`), {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: input.to,
        type: "text",
        text: { preview_url: false, body: input.text },
      }),
    });
    if (!res.ok) {
      throw new WhatsAppApiError(
        "sendText",
        res.status,
        await res.text().catch(() => "no body"),
      );
    }
    const body = (await res.json()) as WhatsAppMessageResponse;
    const id = body.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError("sendText", res.status, "no message id in response");
    return { messageId: id };
  }

  async sendTemplate(input: {
    to: string;
    template: WhatsAppTemplateMessage;
  }): Promise<{ messageId: string }> {
    const res = await this.fetchImpl(this.url(`/${this.phoneNumberId}/messages`), {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: input.to,
        type: "template",
        template: {
          name: input.template.name,
          language: { code: input.template.languageCode },
          ...(input.template.components
            ? { components: input.template.components.map(toTemplateComponent) }
            : {}),
        },
      }),
    });
    if (!res.ok) {
      throw new WhatsAppApiError(
        "sendTemplate",
        res.status,
        await res.text().catch(() => "no body"),
      );
    }
    const body = (await res.json()) as WhatsAppMessageResponse;
    const id = body.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError("sendTemplate", res.status, "no message id");
    return { messageId: id };
  }

  /**
   * Validate phone_number_id + access_token: GET /<phone_number_id>.
   * Возвращает identity row (verified_name, display_phone_number).
   * Бросает WhatsAppApiError на 401/403 (bad token) или 404 (bad ID).
   */
  async getPhoneInfo(): Promise<{
    id: string;
    verifiedName?: string;
    displayPhoneNumber?: string;
    qualityRating?: string;
  }> {
    const res = await this.fetchImpl(this.url(`/${this.phoneNumberId}`), {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new WhatsAppApiError(
        "getPhoneInfo",
        res.status,
        await res.text().catch(() => "no body"),
      );
    }
    const body = (await res.json()) as {
      id: string;
      verified_name?: string;
      display_phone_number?: string;
      quality_rating?: string;
    };
    return {
      id: body.id,
      ...(body.verified_name ? { verifiedName: body.verified_name } : {}),
      ...(body.display_phone_number ? { displayPhoneNumber: body.display_phone_number } : {}),
      ...(body.quality_rating ? { qualityRating: body.quality_rating } : {}),
    };
  }

  /**
   * Re-relay уже загруженного media (по media_id) — без download/re-upload.
   * Cloud API позволяет указать `id` вместо `link`.
   */
  async sendMedia(input: {
    to: string;
    kind: "image" | "video" | "audio" | "document";
    mediaId: string;
    caption?: string;
  }): Promise<{ messageId: string }> {
    const mediaBody: Record<string, unknown> = { id: input.mediaId };
    if (input.caption && (input.kind === "image" || input.kind === "video" || input.kind === "document")) {
      mediaBody.caption = input.caption;
    }
    const res = await this.fetchImpl(this.url(`/${this.phoneNumberId}/messages`), {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: input.to,
        type: input.kind,
        [input.kind]: mediaBody,
      }),
    });
    if (!res.ok) {
      throw new WhatsAppApiError(
        "sendMedia",
        res.status,
        await res.text().catch(() => "no body"),
      );
    }
    const body = (await res.json()) as WhatsAppMessageResponse;
    const id = body.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError("sendMedia", res.status, "no message id");
    return { messageId: id };
  }

  /**
   * Two-step download:
   *   1. GET /<media_id> → { url, mime_type }
   *   2. GET <url> с Bearer'ом → bytes
   *
   * Возвращает `Response` со stream'ом — caller pipe'ит в storage без
   * буферизации (большие файлы).
   */
  async downloadMedia(mediaId: string): Promise<Response> {
    const metaRes = await this.fetchImpl(this.url(`/${mediaId}`), {
      headers: this.authHeaders(),
    });
    if (!metaRes.ok) {
      throw new WhatsAppApiError(
        "downloadMedia.meta",
        metaRes.status,
        await metaRes.text().catch(() => "no body"),
      );
    }
    const meta = (await metaRes.json()) as { url?: string };
    if (!meta.url) {
      throw new WhatsAppApiError("downloadMedia.meta", metaRes.status, "no url in meta");
    }
    const bytesRes = await this.fetchImpl(meta.url, { headers: this.authHeaders() });
    if (!bytesRes.ok) {
      throw new WhatsAppApiError(
        "downloadMedia.bytes",
        bytesRes.status,
        await bytesRes.text().catch(() => "no body"),
      );
    }
    return bytesRes;
  }
}
