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
