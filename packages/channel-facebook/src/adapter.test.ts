import { describe, expect, it } from "bun:test";
import { MessengerAdapter } from "./adapter.ts";
import type { FbWebhookPayload } from "./types.ts";
import { verifyWebhookSubscription } from "./webhook-verify.ts";

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

function adapter(fetchImpl: typeof globalThis.fetch): MessengerAdapter {
  return new MessengerAdapter({ id: "fb1", pageAccessToken: "PTOK", fetch: fetchImpl });
}

describe("MessengerAdapter", () => {
  it("send text → POST /me/messages с RESPONSE + Bearer", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { recipient_id: "PSID", message_id: "m.OUT.1" } },
    ]);
    const a = adapter(fetch);
    const sent = await a.send({
      channelId: "fb1",
      externalUserId: "PSID",
      parts: [{ kind: "text", text: "Привет!" }],
    });
    expect(sent.externalMessageId).toBe("m.OUT.1");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://graph.facebook.com/v18.0/me/messages");
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe("Bearer PTOK");
    expect(call.body).toMatchObject({
      recipient: { id: "PSID" },
      messaging_type: "RESPONSE",
      message: { text: "Привет!" },
    });
  });

  it("send photo → attachment image с url", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { message_id: "m.PHOTO" } }]);
    const a = adapter(fetch);
    await a.send({
      channelId: "fb1",
      externalUserId: "PSID",
      parts: [{ kind: "photo", mediaRef: { channelId: "fb1", externalRef: "https://cdn/i.jpg" } }],
    });
    expect(calls[0]?.body).toMatchObject({
      recipient: { id: "PSID" },
      message: {
        attachment: { type: "image", payload: { url: "https://cdn/i.jpg", is_reusable: false } },
      },
    });
  });

  it("send нескольких parts → первый message_id в результате", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { message_id: "m.A" } },
      { status: 200, body: { message_id: "m.B" } },
    ]);
    const a = adapter(fetch);
    const result = await a.send({
      channelId: "fb1",
      externalUserId: "PSID",
      parts: [
        { kind: "text", text: "one" },
        { kind: "text", text: "two" },
      ],
    });
    expect(result.externalMessageId).toBe("m.A");
    expect(calls).toHaveLength(2);
  });

  it("signalTyping → sender_action typing_on", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { recipient_id: "PSID" } }]);
    const a = adapter(fetch);
    await a.signalTyping("PSID");
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v18.0/me/messages");
    expect(calls[0]?.body).toMatchObject({ recipient: { id: "PSID" }, sender_action: "typing_on" });
  });

  it("send с пустыми parts → ошибка", async () => {
    const { fetch } = fakeFetch([]);
    const a = adapter(fetch);
    await expect(a.send({ channelId: "fb1", externalUserId: "PSID", parts: [] })).rejects.toThrow(
      /non-empty/,
    );
  });

  it("non-2xx от Send API → MessengerApiError", async () => {
    const { fetch } = fakeFetch([
      { status: 401, body: { error: { message: "Invalid OAuth token" } } },
    ]);
    const a = adapter(fetch);
    await expect(
      a.send({ channelId: "fb1", externalUserId: "PSID", parts: [{ kind: "text", text: "x" }] }),
    ).rejects.toThrow(/Messenger sendText failed \(401\)/);
  });

  it("rawClient отдаёт нижележащий MessengerClient", () => {
    const a = adapter((async () => new Response("{}")) as unknown as typeof fetch);
    expect(a.rawClient).toBeDefined();
    expect(typeof a.rawClient.sendText).toBe("function");
  });

  it("send video и document parts → attachment video / file", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { message_id: "m.VID" } },
      { status: 200, body: { message_id: "m.DOC" } },
    ]);
    const a = adapter(fetch);
    const sent = await a.send({
      channelId: "fb1",
      externalUserId: "PSID",
      parts: [
        { kind: "video", mediaRef: { channelId: "fb1", externalRef: "https://cdn/v.mp4" } },
        { kind: "document", mediaRef: { channelId: "fb1", externalRef: "https://cdn/d.pdf" } },
      ],
    });
    expect(sent.externalMessageId).toBe("m.VID");
    expect(calls[0]?.body).toMatchObject({
      message: { attachment: { type: "video", payload: { url: "https://cdn/v.mp4" } } },
    });
    expect(calls[1]?.body).toMatchObject({
      message: { attachment: { type: "file", payload: { url: "https://cdn/d.pdf" } } },
    });
  });

  it("edit/delete → not supported", async () => {
    const a = adapter((async () => new Response("{}")) as unknown as typeof fetch);
    await expect(
      a.edit({ channelId: "fb1", externalUserId: "1", externalMessageId: "2", text: "x" }),
    ).rejects.toThrow(/edit not supported/);
    await expect(
      a.delete({ channelId: "fb1", externalUserId: "1", externalMessageId: "2" }),
    ).rejects.toThrow(/delete not supported/);
  });

  it("downloadMedia: ok → Response; non-ok → MessengerApiError", async () => {
    const okFetch = (async () => new Response("BYTES", { status: 200 })) as unknown as typeof fetch;
    const res = await adapter(okFetch).downloadMedia({
      channelId: "fb1",
      externalRef: "https://cdn/i.jpg",
    });
    expect(await res.text()).toBe("BYTES");

    const badFetch = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
    await expect(
      adapter(badFetch).downloadMedia({ channelId: "fb1", externalRef: "https://cdn/x" }),
    ).rejects.toThrow(/downloadMedia failed \(404\)/);
  });

  it("pushUpdate при ожидающем receive() резолвит waiter напрямую", async () => {
    const a = adapter((async () => new Response("{}")) as unknown as typeof fetch);
    const iter = a.receive()[Symbol.asyncIterator]();
    const pending = iter.next();
    a.pushUpdate({
      object: "page",
      entry: [
        {
          id: "PAGE-1",
          time: 1_700_000_000_000,
          messaging: [
            {
              sender: { id: "PSID" },
              recipient: { id: "PAGE-1" },
              timestamp: 1_700_000_000_000,
              message: { mid: "m.W1", text: "ждали" },
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
    const a = adapter((async () => new Response("{}")) as unknown as typeof fetch);
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
    const a = adapter((async () => new Response("{}")) as unknown as typeof fetch);
    const iter = a.receive()[Symbol.asyncIterator]();
    const pending = iter.next();
    a.close();
    expect((await pending).done).toBe(true);
    expect((await iter.next()).done).toBe(true);
  });

  it("pushUpdate + receive() даёт Inbound", async () => {
    const a = adapter((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
    const payload: FbWebhookPayload = {
      object: "page",
      entry: [
        {
          id: "PAGE-1",
          time: 1_700_000_000_000,
          messaging: [
            {
              sender: { id: "PSID" },
              recipient: { id: "PAGE-1" },
              timestamp: 1_700_000_000_000,
              message: { mid: "m.M1", text: "hi" },
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
    expect(next.value.externalUserId).toBe("PSID");
    a.close();
  });

  it("capabilities: callbackQuery + typing включены, edit/delete выключены", () => {
    const a = adapter((async () => new Response("{}")) as unknown as typeof fetch);
    expect(a.kind).toBe("facebook");
    expect(a.capabilities.callbackQuery).toBe(true);
    expect(a.capabilities.typing).toBe(true);
    expect(a.capabilities.edit).toBe(false);
    expect(a.capabilities.delete).toBe(false);
  });
});

describe("verifyWebhookSubscription (Messenger)", () => {
  it("корректный handshake → 200 + challenge", () => {
    expect(
      verifyWebhookSubscription({
        mode: "subscribe",
        token: "secret",
        challenge: "RND",
        expectedVerifyToken: "secret",
      }),
    ).toEqual({ ok: true, body: "RND", status: 200 });
  });

  it("token mismatch → 403", () => {
    const r = verifyWebhookSubscription({
      mode: "subscribe",
      token: "wrong",
      challenge: "x",
      expectedVerifyToken: "secret",
    });
    expect(r.status).toBe(403);
  });

  it("mode != subscribe → 400", () => {
    expect(
      verifyWebhookSubscription({ mode: "x", token: "s", challenge: "c", expectedVerifyToken: "s" })
        .status,
    ).toBe(400);
  });

  it("missing challenge → 400", () => {
    const r = verifyWebhookSubscription({
      mode: "subscribe",
      token: "secret",
      challenge: null,
      expectedVerifyToken: "secret",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
