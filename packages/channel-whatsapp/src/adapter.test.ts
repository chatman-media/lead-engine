import { describe, expect, it } from "bun:test";
import { WhatsAppCloudAdapter } from "./adapter.ts";
import { verifyWebhookSubscription } from "./webhook-verify.ts";
import type { WaWebhookPayload } from "./types.ts";

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body,
      headers: new Headers(init?.headers as HeadersInit),
    });
    const resp = responses[i++] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe("WhatsAppCloudAdapter", () => {
  it("send text envelope → POST /messages с правильным payload", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { messaging_product: "whatsapp", contacts: [], messages: [{ id: "wa.OUT.1" }] } },
    ]);
    const a = new WhatsAppCloudAdapter({
      id: "wa1",
      phoneNumberId: "PNID",
      accessToken: "TOK",
      fetch,
    });
    const sent = await a.send({
      channelId: "wa1",
      externalUserId: "79161234567",
      parts: [{ kind: "text", text: "Привет!" }],
    });
    expect(sent.externalMessageId).toBe("wa.OUT.1");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://graph.facebook.com/v18.0/PNID/messages");
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe("Bearer TOK");
    expect(call.body).toMatchObject({
      messaging_product: "whatsapp",
      to: "79161234567",
      type: "text",
      text: { body: "Привет!" },
    });
  });

  it("send template envelope → POST /messages type=template", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { messaging_product: "whatsapp", contacts: [], messages: [{ id: "wa.TPL" }] } },
    ]);
    const a = new WhatsAppCloudAdapter({
      id: "wa1",
      phoneNumberId: "PNID",
      accessToken: "TOK",
      fetch,
    });
    const sent = await a.send({
      channelId: "wa1",
      externalUserId: "79161234567",
      parts: [{ kind: "text", text: "fallback/audit text" }],
      transport: {
        whatsapp: {
          template: {
            name: "provider_request_v1",
            languageCode: "en_US",
            approved: true,
            category: "utility",
          },
        },
      },
    });
    expect(sent.externalMessageId).toBe("wa.TPL");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      messaging_product: "whatsapp",
      to: "79161234567",
      type: "template",
      template: {
        name: "provider_request_v1",
        language: { code: "en_US" },
      },
    });
  });

  it("send photo с caption — image type + id+caption", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { messaging_product: "whatsapp", contacts: [], messages: [{ id: "wa.PHOTO" }] } },
    ]);
    const a = new WhatsAppCloudAdapter({
      id: "wa1",
      phoneNumberId: "PNID",
      accessToken: "TOK",
      fetch,
    });
    await a.send({
      channelId: "wa1",
      externalUserId: "79161234567",
      parts: [
        { kind: "photo", mediaRef: { channelId: "wa1", externalRef: "media-IMG" }, caption: "look" },
      ],
    });
    expect(calls[0]?.body).toMatchObject({
      type: "image",
      image: { id: "media-IMG", caption: "look" },
    });
  });

  it("send нескольких parts — first messageId в результате", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { messaging_product: "whatsapp", contacts: [], messages: [{ id: "wa.A" }] } },
      { status: 200, body: { messaging_product: "whatsapp", contacts: [], messages: [{ id: "wa.B" }] } },
    ]);
    const a = new WhatsAppCloudAdapter({
      id: "wa1",
      phoneNumberId: "PNID",
      accessToken: "TOK",
      fetch,
    });
    const result = await a.send({
      channelId: "wa1",
      externalUserId: "79161234567",
      parts: [
        { kind: "text", text: "one" },
        { kind: "text", text: "two" },
      ],
    });
    expect(result.externalMessageId).toBe("wa.A");
    expect(calls).toHaveLength(2);
  });

  it("rawClient отдаёт нижележащий WhatsAppClient", () => {
    const { fetch } = fakeFetch([]);
    const a = new WhatsAppCloudAdapter({ id: "wa1", phoneNumberId: "PNID", accessToken: "TOK", fetch });
    expect(a.rawClient).toBeDefined();
    expect(typeof a.rawClient.sendText).toBe("function");
  });

  it("send: пустые parts без template → throws", async () => {
    const { fetch } = fakeFetch([]);
    const a = new WhatsAppCloudAdapter({ id: "wa1", phoneNumberId: "PNID", accessToken: "TOK", fetch });
    await expect(
      a.send({ channelId: "wa1", externalUserId: "7916", parts: [] }),
    ).rejects.toThrow(/non-empty/);
  });

  it("send video и document parts → правильные media-типы", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { messaging_product: "whatsapp", contacts: [], messages: [{ id: "wa.V" }] } },
      { status: 200, body: { messaging_product: "whatsapp", contacts: [], messages: [{ id: "wa.D" }] } },
    ]);
    const a = new WhatsAppCloudAdapter({ id: "wa1", phoneNumberId: "PNID", accessToken: "TOK", fetch });
    const sent = await a.send({
      channelId: "wa1",
      externalUserId: "7916",
      parts: [
        { kind: "video", mediaRef: { channelId: "wa1", externalRef: "media-VID" }, caption: "v" },
        { kind: "document", mediaRef: { channelId: "wa1", externalRef: "media-DOC" } },
      ],
    });
    expect(sent.externalMessageId).toBe("wa.V");
    expect(calls[0]?.body).toMatchObject({ type: "video", video: { id: "media-VID", caption: "v" } });
    expect(calls[1]?.body).toMatchObject({ type: "document", document: { id: "media-DOC" } });
  });

  it("edit/delete → not supported", async () => {
    const { fetch } = fakeFetch([]);
    const a = new WhatsAppCloudAdapter({ id: "wa1", phoneNumberId: "PNID", accessToken: "TOK", fetch });
    await expect(
      a.edit({ channelId: "wa1", externalUserId: "1", externalMessageId: "2", text: "x" }),
    ).rejects.toThrow(/edit not supported/);
    await expect(
      a.delete({ channelId: "wa1", externalUserId: "1", externalMessageId: "2" }),
    ).rejects.toThrow(/delete not supported/);
  });

  it("downloadMedia: meta-запрос за url, потом байты", async () => {
    const urls: string[] = [];
    const fn = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/file" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("BYTES", { status: 200 });
    }) as unknown as typeof fetch;
    const a = new WhatsAppCloudAdapter({ id: "wa1", phoneNumberId: "PNID", accessToken: "TOK", fetch: fn });
    const res = await a.downloadMedia({ channelId: "wa1", externalRef: "media-IMG-1" });
    expect(await res.text()).toBe("BYTES");
    expect(urls[0]).toContain("/media-IMG-1");
    expect(urls[1]).toBe("https://lookaside.fbsbx.com/file");
  });

  it("signalTyping — no-op, не бросает", async () => {
    const { fetch, calls } = fakeFetch([]);
    const a = new WhatsAppCloudAdapter({ id: "wa1", phoneNumberId: "PNID", accessToken: "TOK", fetch });
    await a.signalTyping("7916");
    expect(calls).toHaveLength(0);
  });

  it("pushUpdate при ожидающем receive() резолвит waiter напрямую", async () => {
    const a = new WhatsAppCloudAdapter({
      id: "wa1",
      phoneNumberId: "PNID",
      accessToken: "TOK",
      fetch: ((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch),
    });
    const iter = a.receive()[Symbol.asyncIterator]();
    const pending = iter.next();
    a.pushUpdate({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "biz",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                messages: [
                  { from: "7916", id: "wa.W1", timestamp: "1700000000", type: "text", text: { body: "ждали" } },
                ],
              },
            },
          ],
        },
      ],
    });
    const next = await pending;
    expect(next.done).toBe(false);
    expect(next.value.parts).toEqual([{ kind: "text", text: "ждали" }]);
  });

  it("receive: уже aborted signal → done; abort во время ожидания → done", async () => {
    const a = new WhatsAppCloudAdapter({
      id: "wa1",
      phoneNumberId: "PNID",
      accessToken: "TOK",
      fetch: ((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch),
    });
    const aborted = new AbortController();
    aborted.abort();
    expect((await a.receive(aborted.signal)[Symbol.asyncIterator]().next()).done).toBe(true);

    const ctrl = new AbortController();
    const iter = a.receive(ctrl.signal)[Symbol.asyncIterator]();
    const pending = iter.next();
    ctrl.abort();
    expect((await pending).done).toBe(true);
  });

  it("close() при ожидающем receive() → done; после close receive сразу done", async () => {
    const a = new WhatsAppCloudAdapter({
      id: "wa1",
      phoneNumberId: "PNID",
      accessToken: "TOK",
      fetch: ((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch),
    });
    const iter = a.receive()[Symbol.asyncIterator]();
    const pending = iter.next();
    a.close();
    expect((await pending).done).toBe(true);
    expect((await iter.next()).done).toBe(true);
  });

  it("pushUpdate + receive() даёт Inbound", async () => {
    const a = new WhatsAppCloudAdapter({
      id: "wa1",
      phoneNumberId: "PNID",
      accessToken: "TOK",
      fetch: ((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch),
    });
    const payload: WaWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "biz",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                messages: [
                  { from: "79161234567", id: "wa.M1", timestamp: "1700000000", type: "text", text: { body: "hi" } },
                ],
              },
            },
          ],
        },
      ],
    };
    a.pushUpdate(payload);
    const iter = a.receive()[Symbol.asyncIterator]();
    const next = await iter.next();
    expect(next.done).toBe(false);
    expect(next.value.parts).toEqual([{ kind: "text", text: "hi" }]);
    a.close();
  });
});

describe("verifyWebhookSubscription", () => {
  it("корректный handshake → 200 + challenge body", () => {
    const r = verifyWebhookSubscription({
      mode: "subscribe",
      token: "secret",
      challenge: "RNDXYZ",
      expectedVerifyToken: "secret",
    });
    expect(r).toEqual({ ok: true, body: "RNDXYZ", status: 200 });
  });

  it("token mismatch → 403", () => {
    const r = verifyWebhookSubscription({
      mode: "subscribe",
      token: "wrong",
      challenge: "x",
      expectedVerifyToken: "secret",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it("mode != subscribe → 400", () => {
    const r = verifyWebhookSubscription({
      mode: "unsubscribe",
      token: "secret",
      challenge: "x",
      expectedVerifyToken: "secret",
    });
    expect(r.status).toBe(400);
  });

  it("missing challenge → 400", () => {
    const r = verifyWebhookSubscription({
      mode: "subscribe",
      token: "secret",
      challenge: null,
      expectedVerifyToken: "secret",
    });
    expect(r.status).toBe(400);
  });
});
