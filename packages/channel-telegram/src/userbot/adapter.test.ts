import type { Inbound } from "@chatman-media/channel-core";
import { describe, expect, it } from "bun:test";
import { TelegramUserbotAdapter } from "./adapter.ts";

function make() {
  return new TelegramUserbotAdapter({ id: "ub1", apiId: 1, apiHash: "h", sessionString: "" });
}
// Доступ к приватам/инъекция фейкового gramjs-клиента.
// biome-ignore lint/suspicious/noExplicitAny: тестовый доступ к приватам
const priv = (a: TelegramUserbotAdapter) => a as any;

function event(over: Record<string, unknown> = {}) {
  return {
    message: {
      senderId: { toString: () => "123" },
      peerId: { className: "PeerUser" },
      message: "hi",
      id: 5,
      ...over,
    },
  };
}

describe("TelegramUserbotAdapter базовое", () => {
  it("kind/id/capabilities", () => {
    const a = make();
    expect(a.kind).toBe("telegram_userbot");
    expect(a.id).toBe("ub1");
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.callbackQuery).toBe(false);
  });
});

describe("eventToInbound", () => {
  it("текст → text-part", () => {
    const inb = priv(make()).eventToInbound(event());
    expect(inb.externalUserId).toBe("123");
    expect(inb.externalMessageId).toBe("5");
    expect(inb.parts).toEqual([{ kind: "text", text: "hi" }]);
  });
  it("фото → photo-part с caption", () => {
    const inb = priv(make()).eventToInbound(event({ message: "подпись", photo: {}, id: 7 }));
    expect(inb.parts[0]).toMatchObject({ kind: "photo", caption: "подпись" });
  });
  it("video / voice / document", () => {
    const a = priv(make());
    expect(a.eventToInbound(event({ message: "", video: { duration: 3 }, photo: undefined })).parts[0].kind).toBe("video");
    expect(a.eventToInbound(event({ message: "", voice: { duration: 2 } })).parts[0]).toMatchObject({ kind: "voice", durationSec: 2 });
    expect(
      a.eventToInbound(event({ message: "", document: { mimeType: "application/pdf", attributes: [{ fileName: "x.pdf" }] } })).parts[0],
    ).toMatchObject({ kind: "document", mimeType: "application/pdf", fileName: "x.pdf" });
  });
  it("не-private peer → null", () => {
    expect(priv(make()).eventToInbound(event({ peerId: { className: "PeerChannel" } }))).toBeNull();
  });
  it("нет senderId → null", () => {
    expect(priv(make()).eventToInbound(event({ senderId: undefined }))).toBeNull();
  });
  it("пустой текст без медиа → null", () => {
    expect(priv(make()).eventToInbound(event({ message: "" }))).toBeNull();
  });
});

describe("cacheMessage LRU", () => {
  it("вытесняет старейшие при превышении лимита", () => {
    const a = priv(make());
    for (let i = 0; i < 300; i++) a.cacheMessage("u", String(i), { i });
    expect(a.recentMessages.size).toBe(256);
    expect(a.recentMessages.has("u:0")).toBe(false); // старейшие вытеснены
    expect(a.recentMessages.has("u:299")).toBe(true);
  });
});

describe("receive() очередь", () => {
  it("отдаёт заэнкью'енные inbound, затем done после close", async () => {
    const a = make();
    priv(a).enqueue({ channelId: "ub1", externalMessageId: "1", externalUserId: "123", parts: [], receivedAt: 0 } as unknown as Inbound);
    const it = a.receive()[Symbol.asyncIterator]();
    expect((await it.next()).value.externalMessageId).toBe("1");
    await a.close();
    expect((await it.next()).done).toBe(true);
  });
});

describe("healthEvents()", () => {
  it("эмит → читается из итератора", async () => {
    const a = make();
    priv(a).emitHealth({ status: "connected" });
    const it = a.healthEvents()[Symbol.asyncIterator]();
    expect((await it.next()).value.status).toBe("connected");
  });
});

describe("send / delete / downloadMedia / signalTyping", () => {
  const fakeClient = () => ({
    sendMessage: async () => ({ id: 42 }),
    deleteMessages: async () => {},
    downloadMedia: async () => Buffer.from("MEDIA"),
    getInputEntity: async (id: number) => ({ id }),
    invoke: async () => ({}),
    disconnect: async () => {},
    connected: true,
  });

  it("send до connect → throws", async () => {
    await expect(make().send({ externalUserId: "1", parts: [{ kind: "text", text: "x" }] } as never)).rejects.toThrow("before connect");
  });
  it("send пустые parts → throws", async () => {
    const a = make();
    priv(a).client = fakeClient();
    await expect(a.send({ externalUserId: "1", parts: [] } as never)).rejects.toThrow("non-empty");
  });
  it("send текст → Sent с id", async () => {
    const a = make();
    priv(a).client = fakeClient();
    const sent = await a.send({ externalUserId: "999", parts: [{ kind: "text", text: "hi" }] } as never);
    expect(sent.externalMessageId).toBe("42");
    expect(sent.channelId).toBe("ub1");
  });
  it("send неподдержанный part.kind → throws", async () => {
    const a = make();
    priv(a).client = fakeClient();
    await expect(a.send({ externalUserId: "1", parts: [{ kind: "photo", mediaRef: { channelId: "ub1", externalRef: "r" } }] } as never)).rejects.toThrow("unsupported");
  });

  it("delete до connect → throws; NaN id → throws; ok с клиентом", async () => {
    await expect(make().delete({ externalUserId: "1", externalMessageId: "2" } as never)).rejects.toThrow("before connect");
    const a = make();
    priv(a).client = fakeClient();
    await expect(a.delete({ externalUserId: "1", externalMessageId: "nope" } as never)).rejects.toThrow("numeric");
    await a.delete({ externalUserId: "1", externalMessageId: "2" } as never); // не бросает
  });

  it("downloadMedia: guards + успех из кэша", async () => {
    await expect(make().downloadMedia({ channelId: "ub1", externalRef: "7" })).rejects.toThrow("before connect");
    const a = make();
    priv(a).client = fakeClient();
    await expect(a.downloadMedia({ channelId: "ub1", externalRef: "7" })).rejects.toThrow("externalUserId");
    await expect(a.downloadMedia({ channelId: "ub1", externalRef: "7" }, { externalUserId: "123" })).rejects.toThrow("evicted");
    priv(a).recentMessages.set("123:7", { msg: true });
    const res = await a.downloadMedia({ channelId: "ub1", externalRef: "7" }, { externalUserId: "123" });
    expect(await res.text()).toBe("MEDIA");
  });

  it("signalTyping: без клиента no-op; с клиентом invoke", async () => {
    await make().signalTyping("1"); // no-op, не бросает
    const a = make();
    let invoked = false;
    priv(a).client = { ...fakeClient(), invoke: async () => { invoked = true; } };
    await a.signalTyping("123");
    expect(invoked).toBe(true);
  });

  it("resolvePeer NaN → throws", async () => {
    const a = make();
    priv(a).client = fakeClient();
    await expect(priv(a).resolvePeer("not-a-number")).rejects.toThrow("invalid externalUserId");
  });

  it("edit всегда throws (capability disabled)", async () => {
    await expect(make().edit({} as never)).rejects.toThrow("disabled");
  });
});

describe("registerHandler + receive abort", () => {
  it("registerHandler ставит обработчик, эмитит connected, входящее → inbox+cache", async () => {
    const a = make();
    let handler: ((e: unknown) => Promise<void>) | null = null;
    priv(a).registerHandler({ addEventHandler: (h: (e: unknown) => Promise<void>) => { handler = h; } });
    // эмит "connected"
    const hIt = a.healthEvents()[Symbol.asyncIterator]();
    expect((await hIt.next()).value.status).toBe("connected");
    // прогоняем входящее сообщение через захваченный обработчик
    expect(handler).not.toBeNull();
    await handler!(event());
    expect(priv(a).recentMessages.has("123:5")).toBe(true);
    const rIt = a.receive()[Symbol.asyncIterator]();
    expect((await rIt.next()).value.externalUserId).toBe("123");
  });

  it("registerHandler пропускает свои исходящие (out)", async () => {
    const a = make();
    let handler: ((e: unknown) => Promise<void>) | null = null;
    priv(a).registerHandler({ addEventHandler: (h: (e: unknown) => Promise<void>) => { handler = h; } });
    await handler!({ message: { out: true, senderId: { toString: () => "1" }, peerId: { className: "PeerUser" }, message: "x", id: 1 } });
    expect(priv(a).inbox.length).toBe(0);
  });

  it("receive(): abort прерывает ожидание (done)", async () => {
    const a = make();
    const ctrl = new AbortController();
    const it = a.receive(ctrl.signal)[Symbol.asyncIterator]();
    const p = it.next(); // нет элементов → ждёт
    ctrl.abort();
    expect((await p).done).toBe(true);
  });
});
