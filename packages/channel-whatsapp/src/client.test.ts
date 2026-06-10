// Unit tests for WhatsAppClient — обёртка над Meta Graph Cloud API. Транспорт
// через мок-fetch: сборка запроса (url/version/auth/body), парсинг ответа,
// error-ветки (non-ok → WhatsAppApiError), two-step downloadMedia.

import { describe, expect, it } from "bun:test";
import { type FetchLike, WhatsAppApiError, WhatsAppClient } from "./client.ts";

interface MockCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; text?: string },
  calls?: MockCall[],
): FetchLike {
  return (async (url: string, init?: RequestInit) => {
    calls?.push({ url, init });
    const r = handler(url, init);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body ?? {},
      text: async () => r.text ?? JSON.stringify(r.body ?? {}),
    } as Response;
  }) as unknown as FetchLike;
}

const opts = (fetch: FetchLike) => ({
  phoneNumberId: "PNID1",
  accessToken: "tok-123",
  fetch,
});

const okSend = { messaging_product: "whatsapp", contacts: [], messages: [{ id: "wamid.1" }] };

describe("WhatsAppClient constructor", () => {
  it("требует phoneNumberId и accessToken", () => {
    expect(() => new WhatsAppClient({ phoneNumberId: "", accessToken: "t" })).toThrow(
      /phoneNumberId required/,
    );
    expect(() => new WhatsAppClient({ phoneNumberId: "p", accessToken: "" })).toThrow(
      /accessToken required/,
    );
  });
});

describe("sendText", () => {
  it("POST messages с правильным url/version/auth/body → messageId", async () => {
    const calls: MockCall[] = [];
    const c = new WhatsAppClient(opts(mockFetch(() => ({ body: okSend }), calls)));
    const r = await c.sendText({ to: "79161234567", text: "привет" });
    expect(r.messageId).toBe("wamid.1");
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v18.0/PNID1/messages");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-123");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "79161234567", type: "text" });
    expect(body.text.body).toBe("привет");
  });

  it("custom apiVersion + baseUrl с хвостовыми слэшами", async () => {
    const calls: MockCall[] = [];
    const c = new WhatsAppClient({
      phoneNumberId: "P",
      accessToken: "t",
      apiVersion: "v20.0",
      baseUrl: "https://proxy.local//",
      fetch: mockFetch(() => ({ body: okSend }), calls),
    });
    await c.sendText({ to: "1", text: "x" });
    expect(calls[0]?.url).toBe("https://proxy.local/v20.0/P/messages");
  });

  it("non-ok → WhatsAppApiError с кодом", async () => {
    const c = new WhatsAppClient(opts(mockFetch(() => ({ status: 401, text: "bad token" }))));
    await expect(c.sendText({ to: "1", text: "x" })).rejects.toThrow(WhatsAppApiError);
    await expect(c.sendText({ to: "1", text: "x" })).rejects.toThrow(/sendText failed \(401\)/);
  });

  it("ответ без message id → throw", async () => {
    const c = new WhatsAppClient(opts(mockFetch(() => ({ body: { messages: [] } }))));
    await expect(c.sendText({ to: "1", text: "x" })).rejects.toThrow(/no message id/);
  });
});

describe("sendTemplate", () => {
  it("POST messages с type=template, language и components", async () => {
    const calls: MockCall[] = [];
    const c = new WhatsAppClient(opts(mockFetch(() => ({ body: okSend }), calls)));
    const r = await c.sendTemplate({
      to: "79161234567",
      template: {
        name: "provider_request_v1",
        languageCode: "en_US",
        approved: true,
        category: "utility",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "massage" },
              { type: "text", text: "Chaweng" },
            ],
          },
        ],
      },
    });
    expect(r.messageId).toBe("wamid.1");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "79161234567",
      type: "template",
      template: {
        name: "provider_request_v1",
        language: { code: "en_US" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "massage" },
              { type: "text", text: "Chaweng" },
            ],
          },
        ],
      },
    });
  });

  it("media template parameter maps mediaRef to Meta id payload", async () => {
    const calls: MockCall[] = [];
    const c = new WhatsAppClient(opts(mockFetch(() => ({ body: okSend }), calls)));
    await c.sendTemplate({
      to: "1",
      template: {
        name: "doc_notice",
        languageCode: "en_US",
        components: [
          {
            type: "header",
            parameters: [
              {
                type: "document",
                mediaRef: { channelId: "wa", externalRef: "media-doc-1" },
              },
            ],
          },
        ],
      },
    });
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.template.components[0].parameters[0]).toEqual({
      type: "document",
      document: { id: "media-doc-1" },
    });
  });

  it("non-ok → WhatsAppApiError с sendTemplate", async () => {
    const c = new WhatsAppClient(opts(mockFetch(() => ({ status: 400, text: "bad template" }))));
    await expect(
      c.sendTemplate({
        to: "1",
        template: { name: "bad", languageCode: "en_US" },
      }),
    ).rejects.toThrow(/sendTemplate failed \(400\)/);
  });
});

describe("getPhoneInfo", () => {
  it("маппит verified_name/display_phone_number/quality_rating", async () => {
    const c = new WhatsAppClient(
      opts(
        mockFetch(() => ({
          body: {
            id: "PNID1",
            verified_name: "Acme",
            display_phone_number: "+1 555",
            quality_rating: "GREEN",
          },
        })),
      ),
    );
    const r = await c.getPhoneInfo();
    expect(r).toEqual({
      id: "PNID1",
      verifiedName: "Acme",
      displayPhoneNumber: "+1 555",
      qualityRating: "GREEN",
    });
  });

  it("минимальный ответ (только id)", async () => {
    const c = new WhatsAppClient(opts(mockFetch(() => ({ body: { id: "X" } }))));
    expect(await c.getPhoneInfo()).toEqual({ id: "X" });
  });

  it("403 → WhatsAppApiError", async () => {
    const c = new WhatsAppClient(opts(mockFetch(() => ({ status: 403, text: "forbidden" }))));
    await expect(c.getPhoneInfo()).rejects.toThrow(/getPhoneInfo failed \(403\)/);
  });
});

describe("sendMedia", () => {
  it("image с caption → body type=image, id+caption", async () => {
    const calls: MockCall[] = [];
    const c = new WhatsAppClient(opts(mockFetch(() => ({ body: okSend }), calls)));
    const r = await c.sendMedia({ to: "1", kind: "image", mediaId: "m1", caption: "подпись" });
    expect(r.messageId).toBe("wamid.1");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.type).toBe("image");
    expect(body.image).toEqual({ id: "m1", caption: "подпись" });
  });

  it("audio игнорирует caption (нет поддержки)", async () => {
    const calls: MockCall[] = [];
    const c = new WhatsAppClient(opts(mockFetch(() => ({ body: okSend }), calls)));
    await c.sendMedia({ to: "1", kind: "audio", mediaId: "a1", caption: "нет" });
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.audio).toEqual({ id: "a1" });
  });

  it("non-ok → WhatsAppApiError", async () => {
    const c = new WhatsAppClient(opts(mockFetch(() => ({ status: 500, text: "err" }))));
    await expect(c.sendMedia({ to: "1", kind: "video", mediaId: "v" })).rejects.toThrow(
      /sendMedia failed \(500\)/,
    );
  });

  it("нет message id → throw", async () => {
    const c = new WhatsAppClient(opts(mockFetch(() => ({ body: { messages: [] } }))));
    await expect(c.sendMedia({ to: "1", kind: "document", mediaId: "d" })).rejects.toThrow(
      /no message id/,
    );
  });
});

describe("downloadMedia (two-step)", () => {
  it("meta → url → bytes", async () => {
    const calls: MockCall[] = [];
    const c = new WhatsAppClient(
      opts(
        mockFetch((url) => {
          if (url.includes("/m99")) return { body: { url: "https://cdn.local/file.bin" } };
          return { body: { ok: true } };
        }, calls),
      ),
    );
    const res = await c.downloadMedia("m99");
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://cdn.local/file.bin");
  });

  it("meta non-ok → WhatsAppApiError", async () => {
    const c = new WhatsAppClient(opts(mockFetch(() => ({ status: 404, text: "no media" }))));
    await expect(c.downloadMedia("m1")).rejects.toThrow(/downloadMedia.meta failed \(404\)/);
  });

  it("meta без url → throw", async () => {
    const c = new WhatsAppClient(opts(mockFetch(() => ({ body: {} }))));
    await expect(c.downloadMedia("m1")).rejects.toThrow(/no url in meta/);
  });

  it("bytes non-ok → WhatsAppApiError", async () => {
    const c = new WhatsAppClient(
      opts(
        mockFetch((url) => {
          if (url.includes("/m1")) return { body: { url: "https://cdn.local/x" } };
          return { status: 500, text: "cdn down" };
        }),
      ),
    );
    await expect(c.downloadMedia("m1")).rejects.toThrow(/downloadMedia.bytes failed \(500\)/);
  });
});
