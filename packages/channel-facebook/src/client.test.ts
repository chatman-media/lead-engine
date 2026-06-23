// Unit tests for MessengerClient — обёртка над Meta Graph (Messenger Platform).
// Транспорт через мок-fetch: sendText/sendAttachment/sendAction (POST
// /me/messages), getPageInfo (GET /me), downloadMedia + error-ветки.

import { describe, expect, it } from "bun:test";
import { type FetchLike, MessengerApiError, MessengerClient } from "./client.ts";

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

const opts = (fetch: FetchLike) => ({ pageAccessToken: "page-tok", fetch });

describe("MessengerClient constructor", () => {
  it("требует pageAccessToken", () => {
    expect(() => new MessengerClient({ pageAccessToken: "" })).toThrow(/pageAccessToken required/);
  });
});

describe("sendText", () => {
  it("POST /me/messages с RESPONSE + auth → messageId", async () => {
    const calls: MockCall[] = [];
    const c = new MessengerClient(
      opts(mockFetch(() => ({ body: { message_id: "mid.1" } }), calls)),
    );
    const r = await c.sendText({ to: "PSID1", text: "привет" });
    expect(r.messageId).toBe("mid.1");
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v18.0/me/messages");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer page-tok");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toMatchObject({ recipient: { id: "PSID1" }, messaging_type: "RESPONSE" });
    expect(body.message.text).toBe("привет");
  });

  it("non-ok → MessengerApiError", async () => {
    const c = new MessengerClient(opts(mockFetch(() => ({ status: 401, text: "bad" }))));
    await expect(c.sendText({ to: "P", text: "x" })).rejects.toThrow(MessengerApiError);
  });

  it("нет message_id → throw", async () => {
    const c = new MessengerClient(opts(mockFetch(() => ({ body: {} }))));
    await expect(c.sendText({ to: "P", text: "x" })).rejects.toThrow(/no message_id/);
  });
});

describe("sendAttachment", () => {
  it("image payload.url + is_reusable:false → messageId", async () => {
    const calls: MockCall[] = [];
    const c = new MessengerClient(
      opts(mockFetch(() => ({ body: { message_id: "mid.2" } }), calls)),
    );
    const r = await c.sendAttachment({ to: "P", kind: "image", url: "https://cdn/x.jpg" });
    expect(r.messageId).toBe("mid.2");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.message.attachment).toEqual({
      type: "image",
      payload: { url: "https://cdn/x.jpg", is_reusable: false },
    });
  });

  it("нет message_id → throw", async () => {
    const c = new MessengerClient(opts(mockFetch(() => ({ body: {} }))));
    await expect(c.sendAttachment({ to: "P", kind: "file", url: "u" })).rejects.toThrow(
      /no message_id/,
    );
  });
});

describe("sendAction", () => {
  it("sender_action body, без возврата", async () => {
    const calls: MockCall[] = [];
    const c = new MessengerClient(opts(mockFetch(() => ({ body: {} }), calls)));
    await c.sendAction({ to: "P", action: "typing_on" });
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toEqual({ recipient: { id: "P" }, sender_action: "typing_on" });
  });

  it("non-ok → MessengerApiError", async () => {
    const c = new MessengerClient(opts(mockFetch(() => ({ status: 500, text: "err" }))));
    await expect(c.sendAction({ to: "P", action: "mark_seen" })).rejects.toThrow(
      /sendAction failed \(500\)/,
    );
  });
});

describe("getPageInfo", () => {
  it("GET /me?fields=id,name → id + name", async () => {
    const calls: MockCall[] = [];
    const c = new MessengerClient(
      opts(mockFetch(() => ({ body: { id: "PAGE1", name: "Acme Page" } }), calls)),
    );
    expect(await c.getPageInfo()).toEqual({ id: "PAGE1", name: "Acme Page" });
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v18.0/me?fields=id,name");
  });

  it("без name → только id", async () => {
    const c = new MessengerClient(opts(mockFetch(() => ({ body: { id: "P" } }))));
    expect(await c.getPageInfo()).toEqual({ id: "P" });
  });

  it("403 → MessengerApiError", async () => {
    const c = new MessengerClient(opts(mockFetch(() => ({ status: 403, text: "forbidden" }))));
    await expect(c.getPageInfo()).rejects.toThrow(/getPageInfo failed \(403\)/);
  });
});

describe("downloadMedia", () => {
  it("GET url напрямую → Response", async () => {
    const c = new MessengerClient(opts(mockFetch(() => ({ body: { ok: true } }))));
    const res = await c.downloadMedia("https://lookaside.fbsbx.com/x");
    expect(res.ok).toBe(true);
  });

  it("non-ok → MessengerApiError", async () => {
    const c = new MessengerClient(opts(mockFetch(() => ({ status: 404, text: "gone" }))));
    await expect(c.downloadMedia("https://cdn/x")).rejects.toThrow(/downloadMedia failed \(404\)/);
  });
});
