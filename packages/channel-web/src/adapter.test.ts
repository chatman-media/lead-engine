import { describe, expect, it } from "bun:test";
import { type IWebSocket, WebChannelAdapter, WebDeliveryError } from "./adapter.ts";
import type { Inbound, OutboundEnvelope } from "@chatman-media/channel-core";

class FakeWs implements IWebSocket {
  public sent: string[] = [];
  public closed: { code?: number; reason?: string } | null = null;
  public readyState = 1; // OPEN

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3; // CLOSED
  }
}

describe("WebChannelAdapter", () => {
  it("acceptConnection шлёт ready frame", () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]!);
    expect(frame).toEqual({ type: "ready", channelId: "web1", userId: "user-A" });
  });

  it("второй connect от того же user закрывает первый (superseded)", () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();
    a.acceptConnection(ws1, "user-A");
    a.acceptConnection(ws2, "user-A");
    expect(ws1.closed?.code).toBe(4000);
    expect(ws2.sent[0]).toContain('"ready"');
  });

  it("onClientFrame с валидным user_text → Inbound в receive()", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    a.onClientFrame("user-A", JSON.stringify({ type: "user_text", id: "msg1", text: "hi" }));
    const iter = a.receive()[Symbol.asyncIterator]();
    const next = await iter.next();
    expect(next.done).toBe(false);
    const inbound = next.value as Inbound;
    expect(inbound.externalMessageId).toBe("msg1");
    expect(inbound.externalUserId).toBe("user-A");
    expect(inbound.parts).toEqual([{ kind: "text", text: "hi" }]);
  });

  it("битый frame → error frame клиенту, не enqueue", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    ws.sent.length = 0; // reset
    a.onClientFrame("user-A", "{ malformed");
    expect(ws.sent[0]).toContain('"error"');
    // Inbox пуст — receive не должно ничего видеть (close() чтобы iter завершился).
    const iterPromise = a.receive()[Symbol.asyncIterator]().next();
    a.close();
    const r = await iterPromise;
    expect(r.done).toBe(true);
  });

  it("send text envelope → bot_text frame клиенту", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    ws.sent.length = 0;

    const envelope: OutboundEnvelope = {
      channelId: "web1",
      externalUserId: "user-A",
      parts: [{ kind: "text", text: "Привет!" }],
    };
    const sent = await a.send(envelope);
    expect(sent.externalMessageId).toMatch(/^srv-/);
    const frame = JSON.parse(ws.sent[0]!);
    expect(frame).toMatchObject({ type: "bot_text", text: "Привет!" });
  });

  it("send несколько text parts склеиваются через \\n\\n", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    ws.sent.length = 0;
    await a.send({
      channelId: "web1",
      externalUserId: "user-A",
      parts: [
        { kind: "text", text: "первая" },
        { kind: "text", text: "вторая" },
      ],
    });
    const frame = JSON.parse(ws.sent[0]!);
    expect(frame.text).toBe("первая\n\nвторая");
  });

  it("send media-part → WebDeliveryError (text-only)", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    await expect(
      a.send({
        channelId: "web1",
        externalUserId: "user-A",
        parts: [{ kind: "photo", mediaRef: { channelId: "web1", externalRef: "x" } }],
      }),
    ).rejects.toThrow(WebDeliveryError);
  });

  it("send без активного connection → WebDeliveryError", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    await expect(
      a.send({
        channelId: "web1",
        externalUserId: "user-offline",
        parts: [{ kind: "text", text: "hi" }],
      }),
    ).rejects.toThrow(/no active connection/);
  });

  it("onDisconnect удаляет connection — send падает после", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    a.onDisconnect("user-A");
    await expect(
      a.send({
        channelId: "web1",
        externalUserId: "user-A",
        parts: [{ kind: "text", text: "hi" }],
      }),
    ).rejects.toThrow(/no active connection/);
  });

  it("close() закрывает все connections + drains waiters", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();
    a.acceptConnection(ws1, "u1");
    a.acceptConnection(ws2, "u2");

    const iter = a.receive()[Symbol.asyncIterator]();
    const pending = iter.next();
    a.close();
    const r = await pending;
    expect(r.done).toBe(true);
    expect(ws1.closed?.code).toBe(1001);
    expect(ws2.closed?.code).toBe(1001);
  });

  it("send с replyToExternalMessageId → frame с replyTo", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    ws.sent.length = 0;
    await a.send({
      channelId: "web1",
      externalUserId: "user-A",
      parts: [{ kind: "text", text: "ответ" }],
      replyToExternalMessageId: "msg-42",
    });
    const frame = JSON.parse(ws.sent[0]!);
    expect(frame.replyTo).toBe("msg-42");
  });

  it("send с пустыми parts → throws non-empty", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    await expect(
      a.send({ channelId: "web1", externalUserId: "user-A", parts: [] }),
    ).rejects.toThrow(/non-empty/);
  });

  it("edit/delete/downloadMedia → not supported; signalTyping — no-op", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    await expect(
      a.edit({ channelId: "web1", externalUserId: "u", externalMessageId: "m", text: "x" }),
    ).rejects.toThrow(/edit not supported/);
    await expect(
      a.delete({ channelId: "web1", externalUserId: "u", externalMessageId: "m" }),
    ).rejects.toThrow(/delete not supported/);
    await expect(a.downloadMedia({ channelId: "web1", externalRef: "x" })).rejects.toThrow(
      /downloadMedia not supported/,
    );
    await a.signalTyping("u"); // no-op, не бросает
  });

  it("acceptConnection: бросающий close у старого соединения проглатывается", () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const throwingWs: IWebSocket = {
      readyState: 1,
      send: () => {},
      close: () => {
        throw new Error("boom");
      },
    };
    a.acceptConnection(throwingWs, "user-A");
    const ws2 = new FakeWs();
    a.acceptConnection(ws2, "user-A"); // не бросает
    expect(ws2.sent[0]).toContain('"ready"');
  });

  it("close(): бросающий close у соединения проглатывается", () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const throwingWs: IWebSocket = {
      readyState: 1,
      send: () => {},
      close: () => {
        throw new Error("boom");
      },
    };
    a.acceptConnection(throwingWs, "user-A");
    a.close(); // не бросает
  });

  it("onClientFrame с битым frame без активного ws → silent drop", () => {
    const a = new WebChannelAdapter({ id: "web1" });
    a.onClientFrame("ghost-user", "{ malformed"); // не бросает, ничего не шлёт
  });

  it("onClientFrame при ожидающем receive() резолвит waiter напрямую", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    const iter = a.receive()[Symbol.asyncIterator]();
    const pending = iter.next();
    a.onClientFrame("user-A", JSON.stringify({ type: "user_text", id: "w1", text: "ждали" }));
    const next = await pending;
    expect(next.done).toBe(false);
    expect((next.value as Inbound).parts).toEqual([{ kind: "text", text: "ждали" }]);
  });

  it("receive: уже aborted signal → done; abort во время ожидания → done", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const aborted = new AbortController();
    aborted.abort();
    expect((await a.receive(aborted.signal)[Symbol.asyncIterator]().next()).done).toBe(true);

    const ctrl = new AbortController();
    const iter = a.receive(ctrl.signal)[Symbol.asyncIterator]();
    const pending = iter.next();
    ctrl.abort();
    expect((await pending).done).toBe(true);
  });

  it("receive после close() сразу done", async () => {
    const a = new WebChannelAdapter({ id: "web1" });
    a.close();
    expect((await a.receive()[Symbol.asyncIterator]().next()).done).toBe(true);
  });

  it("валидный JSON, но неизвестный type / не-объект → bad_frame error", () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    ws.sent.length = 0;
    a.onClientFrame("user-A", JSON.stringify({ type: "ping" }));
    expect(ws.sent[0]).toContain('"error"');
    ws.sent.length = 0;
    a.onClientFrame("user-A", "42");
    expect(ws.sent[0]).toContain('"error"');
  });

  it("text слишком длинный (> 8000) → bad_frame error", () => {
    const a = new WebChannelAdapter({ id: "web1" });
    const ws = new FakeWs();
    a.acceptConnection(ws, "user-A");
    ws.sent.length = 0;
    const longText = "x".repeat(8001);
    a.onClientFrame("user-A", JSON.stringify({ type: "user_text", id: "m", text: longText }));
    expect(ws.sent[0]).toContain('"error"');
  });
});
